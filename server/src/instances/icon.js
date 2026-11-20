// Server icon processing: PNG/JPEG/BMP decode, resize to 64x64 PNG.
// pica/pngjs/jpeg-js are loaded lazily so the panel cold start stays small.

// ============ SERVER ICON ============
// pica/pngjs/jpeg-js are only needed when an icon is uploaded. Loading them lazily
// keeps the panel's cold start (and memory footprint) small.
let iconImageLibsPromise = null;
function loadIconImageLibs() {
  if (!iconImageLibsPromise) {
    iconImageLibsPromise = Promise.all([import("pica"), import("pngjs"), import("jpeg-js")])
      .then(([picaMod, pngMod, jpegMod]) => ({
        pica: new picaMod.default({ features: ["js"] }),
        PNG: pngMod.PNG,
        jpeg: jpegMod.default,
      }))
      .catch((e) => { iconImageLibsPromise = null; throw e; });
  }
  return iconImageLibsPromise;
}

function decodeImageToRgba(buf, { PNG, jpeg }) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const { width, height, data } = PNG.sync.read(b);
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) {
    const { width, height, data } = jpeg.decode(b, { useTArray: true });
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) };
  }
  // BMP (24/32bpp, uncompressed) or reject
  if (b.length >= 54 && b[0] === 0x42 && b[1] === 0x4d) {
    const dataOffset = b.readUInt32LE(10);
    const dib = b.readUInt32LE(14);
    let width = 0, height = 0, bpp = 0;
    if (dib >= 40) { width = b.readInt32LE(18); height = b.readInt32LE(22); bpp = b.readUInt16LE(28); }
    else { throw new Error("Unsupported BMP header"); }
    const topDown = height < 0; height = Math.abs(height);
    if (![24, 32].includes(bpp) || b.readUInt32LE(30) !== 0) throw new Error("Unsupported BMP format (need uncompressed 24/32bpp)");
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcRow = topDown ? y : (height - 1 - y);
      const rowOff = dataOffset + srcRow * rowSize;
      for (let x = 0; x < width; x++) {
        const si = rowOff + x * (bpp / 8);
        const di = (y * width + x) * 4;
        rgba[di] = b[si + 2]; rgba[di + 1] = b[si + 1]; rgba[di + 2] = b[si]; rgba[di + 3] = bpp === 32 ? b[si + 3] : 255;
      }
    }
    return { width, height, data: rgba };
  }
  throw new Error("Unsupported image format (need PNG, JPEG, or BMP)");
}

async function resizeServerIcon(buf) {
  try {
    const { pica, PNG, jpeg } = await loadIconImageLibs();
    const src = decodeImageToRgba(buf, { PNG, jpeg });
    const destArr = new Uint8Array(64 * 64 * 4);
    await pica.resizeBuffer({
      src: new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength),
      width: src.width,
      height: src.height,
      toWidth: 64,
      toHeight: 64,
      dest: destArr,
    });
    const png = PNG.sync.write({ width: 64, height: 64, data: Buffer.from(destArr.buffer, destArr.byteOffset, destArr.byteLength) });
    return Buffer.from(png);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not process image: ${msg}. Supported input: PNG, JPEG, BMP (auto-resized to 64x64 PNG).`);
  }
}

export { resizeServerIcon };
