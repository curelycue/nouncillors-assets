const fse = require('fs-extra');
const path = require('path');
const { PNG } = require('pngjs');

// Utility functions
const toPaddedHex = (c, pad = 2) => {
  return c.toString(16).padStart(pad, '0');
};

const rgbToHex = (r, g, b) => {
  return `${toPaddedHex(r)}${toPaddedHex(g)}${toPaddedHex(b)}`;
};

const readPngImage = async (path) => {
  const buffer = await fse.readFile(path);
  const png = PNG.sync.read(buffer);

  return {
    width: png.width,
    height: png.height,
    rgbaAt: (x, y) => {
      const idx = (png.width * y + x) << 2;
      const [r, g, b, a] = [png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]];
      return { r, g, b, a };
    },
  };
};

// Image and PNGCollectionEncoder classes
class Image {
  constructor(width, height, getRgbaAt) {
    this._width = width;
    this._height = height;
    this._bounds = { top: 0, bottom: 0, left: 0, right: 0 };
    this.tuples = [];
    this._getRgbaAt = getRgbaAt;
  }

  get height() {
    return this._height;
  }

  get width() {
    return this._width;
  }

  get bounds() {
    return this._bounds;
  }

  toRLE(colors) {
    this._bounds = this.calcBounds();

    const indexes = [];

    for (let y = this.bounds.top; y <= this.bounds.bottom; y++) {
      for (let x = this.bounds.left; x < this.bounds.right; x++) {
        const { r, g, b, a } = this._getRgbaAt(x, y);
        const hexColor = rgbToHex(r, g, b);

        if (!colors.has(hexColor)) {
          colors.set(hexColor, colors.size);
        }

        indexes.push(a === 0 ? 0 : colors.get(hexColor));
      }
    }

    const metadata = [0, this.bounds.top, this.bounds.right, this.bounds.bottom, this.bounds.left].map(v => toPaddedHex(v));
    return `0x${metadata.join('')}${this.encode(indexes)}`;
  }

  encode(data) {
    const encoding = [];
    let previous = data[0];
    let count = 1;

    for (let i = 1; i < data.length; i++) {
      if (data[i] !== previous || count === 255) {
        encoding.push(toPaddedHex(count), toPaddedHex(previous));
        this.tuples.push([count, previous]);
        count = 1;
        previous = data[i];
      } else {
        count++;
      }
    }

    if (previous !== undefined) {
      encoding.push(toPaddedHex(count), toPaddedHex(previous));
    }
    return encoding.join('');
  }

  calcBounds() {
    let bottom = this.height - 1;
    while (bottom > 0 && this._isTransparentRow(bottom)) {
      bottom--;
    }

    let top = 0;
    while (top < bottom && this._isTransparentRow(top)) {
      top++;
    }

    let right = this.width - 1;
    while (right >= 0 && this._isTransparentColumn(right)) {
      right--;
    }

    let left = 0;
    while (left < right && this._isTransparentColumn(left)) {
      left++;
    }

    return { top, bottom, left, right: right + 1 };
  }

  _isTransparentColumn(column) {
    for (let row = 0; row < this.height; row++) {
      if (this._getRgbaAt(column, row).a !== 0) {
        return false;
      }
    }
    return true;
  }

  _isTransparentRow(row) {
    for (let column = 0; column < this.width; column++) {
      if (this._getRgbaAt(column, row).a !== 0) {
        return false;
      }
    }
    return true;
  }
}

class PNGCollectionEncoder {
  constructor(colors) {
    this._transparent = ['', 0];
    this._colors = new Map([this._transparent]);
    this._images = new Map();
    this._folders = {};

    if (colors) {
      colors.forEach((color, index) => this._colors.set(color, index));
    }
  }

  get images() {
    return this.format(true).root;
  }

  get data() {
    return { palette: [...this._colors.keys()], images: this.format() };
  }

  encodeImage(name, png, folder) {
    const image = new Image(png.width, png.height, png.rgbaAt);
    const rle = image.toRLE(this._colors);

    this._images.set(name, rle);

    if (folder) {
      (this._folders[folder] ||= []).push(name);
    }

    return rle;
  }

  async writeToFile(outputFile = 'encoded-images.json') {
    await fse.writeFile(outputFile, JSON.stringify(this.data, null, 2));
  }

  format(flatten = false) {
    const images = new Map(this._images);
    const folders = Object.entries(this._folders);

    let data = {};
    if (!flatten && folders.length) {
      data = folders.reduce((result, [folder, filenames]) => {
        result[folder] = [];

        filenames.forEach(filename => {
          result[folder].push({ filename, data: images.get(filename) });
          images.delete(filename);
        });

        return result;
      }, {});
    }

    if (images.size) {
      data.root = [...images.entries()].map(([filename, data]) => ({ filename, data }));
    }
    return data;
  }
}

// Main encode function
const DESTINATION = path.join(__dirname, '../src/image-data.json');

const encode = async () => {
  const encoder = new PNGCollectionEncoder();

  const partfolders = ['1-bodies', '2-accessories', '3-heads', '4-glasses'];
  for (const folder of partfolders) {
    const folderpath = path.join(__dirname, '../images/v0', folder);
    const files = await fse.readdir(folderpath);
    for (const file of files) {
      const image = await readPngImage(path.join(folderpath, file));
      encoder.encodeImage(file.replace(/\.png$/, ''), image, folder.replace(/^\d-/, ''));
    }
  }

  await fse.writeFile(
    DESTINATION,
    JSON.stringify(
      {
        bgcolors: ['d5d7e1', 'e1d7d5'],
        ...encoder.data,
      },
      null,
      2,
    ),
  );
};

encode();
