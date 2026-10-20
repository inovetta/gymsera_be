/**
 * SEC-08: uploads.
 *  - the bytes must be what the Content-Type claims (JPEG, PNG, WebP, PDF); an .html renamed .jpg is refused
 *  - images are re-encoded: EXIF (GPS, camera), trailing bytes and hidden payloads are gone, the picture
 *    is still upright; documents (KYC) are checked by signature and stored untouched
 *  - in production a failed or missing R2 means the upload fails (503), never a write to public disk
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

const upload = require('../../src/middleware/upload');
const errorHandler = require('../../src/middleware/errorHandler');
const { sniffMime, matchesDeclared } = require('../../src/utils/file-signature');

const ROOT = path.join(__dirname, '..', '..');

const img = (format, { w = 20, h = 10, orientation, exif } = {}) => {
  let p = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } });
  if (orientation) p = p.withMetadata({ orientation });
  if (exif) p = p.withExif(exif);
  return p[format]().toBuffer();
};
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

let server;
beforeAll(async () => {
  const app = express();
  const echo = (req, res) => {
    const files = req.file ? [req.file] : req.files || [];
    res.json({ files: files.map((f) => ({ mimetype: f.mimetype, size: f.size, b64: f.buffer.toString('base64') })) });
  };
  app.post('/image', upload.image('image'), upload.handleMulterError, echo);
  app.post('/images', upload.images('images', 3), upload.handleMulterError, echo);
  app.post('/document', upload.document('document'), upload.handleMulterError, echo);
  app.post('/documents', upload.documents('documents', 3), upload.handleMulterError, echo);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(() => new Promise((r) => server.close(r)));

const send = (route, field, buffer, type, name = 'f.bin') =>
  request(server).post(route).attach(field, buffer, { filename: name, contentType: type });

describe('SEC-08: file signatures', () => {
  test('recognises the four accepted types from real files', async () => {
    expect(sniffMime(await img('jpeg'))).toBe('image/jpeg');
    expect(sniffMime(await img('png'))).toBe('image/png');
    expect(sniffMime(await img('webp'))).toBe('image/webp');
    expect(sniffMime(PDF)).toBe('application/pdf');
  });

  test('refuses HTML, GIF, SVG, WAV (RIFF but not WebP), a PDF header that is not at offset 0, and tiny buffers', () => {
    expect(sniffMime(HTML)).toBeNull();
    expect(sniffMime(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]))).toBeNull();
    expect(sniffMime(Buffer.concat([Buffer.from('<html>'), PDF]))).toBeNull();
    expect(sniffMime(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(sniffMime(null)).toBeNull();
  });

  test('matchesDeclared accepts the image/jpg spelling and rejects a mismatch', async () => {
    const jpeg = await img('jpeg');
    expect(matchesDeclared(jpeg, 'image/jpg')).toBe(true);
    expect(matchesDeclared(jpeg, 'image/png')).toBe(false);
  });
});

describe('SEC-08: image routes', () => {
  test.each([
    ['HTML as image/jpeg', HTML, 'image/jpeg'],
    ['PNG bytes claimed as JPEG', null, 'image/jpeg'],
    ['PDF on an image route', PDF, 'image/png'],
  ])('%s is refused with 422', async (_n, buf, type) => {
    const body = buf || (await img('png'));
    const res = await send('/image', 'image', body, type, 'x.jpg');
    expect(res.status).toBe(422);
  });

  test('an image with a valid signature but garbage inside is refused, not stored', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('this is not a jpeg body'.repeat(20))]);
    const res = await send('/image', 'image', broken, 'image/jpeg', 'x.jpg');
    expect(res.status).toBe(422);
  });

  test('EXIF (description, copyright) is stripped and the pixels are kept', async () => {
    const original = await img('jpeg', { exif: { IFD0: { ImageDescription: 'secret-home-address', Copyright: 'owner' } } });
    expect((await sharp(original).metadata()).exif).toBeTruthy();
    expect(original.toString('latin1')).toContain('secret-home-address');
    const res = await send('/image', 'image', original, 'image/jpeg', 'photo.jpg');
    expect(res.status).toBe(200);
    const out = Buffer.from(res.body.files[0].b64, 'base64');
    expect(out.toString('latin1')).not.toContain('secret-home-address');
    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([20, 10]);
    expect(res.body.files[0].mimetype).toBe('image/jpeg');
    expect(res.body.files[0].size).toBe(out.length);
  });

  test('bytes appended after the image (a hidden payload) do not survive', async () => {
    const original = Buffer.concat([await img('png'), Buffer.from('<script>steal()</script>')]);
    const res = await send('/image', 'image', original, 'image/png', 'a.png');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.files[0].b64, 'base64').toString('latin1')).not.toContain('steal()');
  });

  test('a rotated phone photo comes out upright before the orientation tag is dropped', async () => {
    const original = await img('jpeg', { w: 20, h: 10, orientation: 6 });
    const res = await send('/image', 'image', original, 'image/jpeg', 'p.jpg');
    const meta = await sharp(Buffer.from(res.body.files[0].b64, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([10, 20]);
    expect(meta.orientation).toBeUndefined();
  });

  test('PNG and WebP stay their own type', async () => {
    for (const [fmt, type] of [['png', 'image/png'], ['webp', 'image/webp']]) {
      const res = await send('/image', 'image', await img(fmt), type, `a.${fmt}`);
      expect(res.status).toBe(200);
      expect(sniffMime(Buffer.from(res.body.files[0].b64, 'base64'))).toBe(type);
    }
  });

  test('multiple images: one bad file refuses the request', async () => {
    const res = await request(server).post('/images')
      .attach('images', await img('png'), { filename: 'a.png', contentType: 'image/png' })
      .attach('images', HTML, { filename: 'b.png', contentType: 'image/png' });
    expect(res.status).toBe(422);
  });
});

describe('SEC-08: document routes (KYC): signature only, bytes untouched', () => {
  test('a PDF passes through byte for byte', async () => {
    const res = await send('/document', 'document', PDF, 'application/pdf', 'd.pdf');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.files[0].b64, 'base64').equals(PDF)).toBe(true);
  });

  test('an image document is not re-encoded', async () => {
    const png = await img('png');
    const res = await send('/documents', 'documents', png, 'image/png', 'd.png');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body.files[0].b64, 'base64').equals(png)).toBe(true);
  });

  test('HTML claimed as a PDF, and a PDF claimed as a PNG, are refused', async () => {
    expect((await send('/document', 'document', HTML, 'application/pdf', 'd.pdf')).status).toBe(422);
    expect((await send('/document', 'document', PDF, 'image/png', 'd.png')).status).toBe(422);
  });
});

describe('SEC-08: sharp unavailable on a host', () => {
  test('uploads still pass the signature check and are stored as received, with one warning', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let sanitizer;
    jest.isolateModules(() => {
      jest.doMock('sharp', () => { throw new Error('Could not load the "sharp" module'); });
      sanitizer = require('../../src/services/image-sanitizer');
    });
    const png = await img('png');
    expect(sanitizer.available()).toBe(false);
    const out = await sanitizer.sanitizeImage(png, 'image/png');
    expect(out).toEqual({ buffer: png, reencoded: false });
    await sanitizer.sanitizeImage(png, 'image/png');
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[image-sanitizer]'))).toHaveLength(1);
    warn.mockRestore();
    jest.dontMock('sharp');
  });
});

describe('SEC-08: storage fails closed in production', () => {
  const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];
  const saved = {};
  const uploadsDir = path.join(ROOT, 'public/uploads');

  beforeEach(() => { for (const k of ['NODE_ENV', ...R2_KEYS]) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    jest.dontMock('@aws-sdk/client-s3');
  });

  const loadStorage = (sendImpl) => {
    let svc;
    jest.isolateModules(() => {
      jest.doMock('@aws-sdk/client-s3', () => ({
        S3Client: function S3Client() { this.send = sendImpl; },
        PutObjectCommand: function PutObjectCommand(a) { this.a = a; },
        DeleteObjectCommand: function DeleteObjectCommand(a) { this.a = a; },
      }));
      svc = require('../../src/services/storage.service');
    });
    return svc;
  };
  const leftovers = (folder) => (fs.existsSync(path.join(uploadsDir, folder)) ? fs.readdirSync(path.join(uploadsDir, folder)) : []);

  test('production without R2 settings: 503 and nothing written to public disk', async () => {
    process.env.NODE_ENV = 'production';
    for (const k of R2_KEYS) delete process.env[k];
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const svc = loadStorage(jest.fn());
    await expect(svc.uploadImage(Buffer.from('x'), 'image/png', 'sec08-prod-missing')).rejects.toMatchObject({ statusCode: 503 });
    expect(leftovers('sec08-prod-missing')).toEqual([]);
    err.mockRestore();
  });

  test('production with R2 failing: 503 and nothing written to public disk', async () => {
    process.env.NODE_ENV = 'production';
    Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PUBLIC_URL: 'https://cdn.example.com' });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const svc = loadStorage(jest.fn().mockRejectedValue(new Error('R2 down')));
    await expect(svc.uploadImage(Buffer.from('x'), 'image/png', 'sec08-prod-fail')).rejects.toMatchObject({ statusCode: 503 });
    expect(leftovers('sec08-prod-fail')).toEqual([]);
    err.mockRestore();
  });

  test('production with R2 working returns the public R2 URL', async () => {
    process.env.NODE_ENV = 'production';
    Object.assign(process.env, { R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_PUBLIC_URL: 'https://cdn.example.com' });
    const svc = loadStorage(jest.fn().mockResolvedValue({}));
    const url = await svc.uploadImage(Buffer.from('x'), 'image/png', 'folder', 'name');
    expect(url).toBe('https://cdn.example.com/folder/name.png');
  });

  test('development and tests still use the local-disk fallback', async () => {
    process.env.NODE_ENV = 'test';
    for (const k of R2_KEYS) delete process.env[k];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = loadStorage(jest.fn());
    const url = await svc.uploadImage(Buffer.from('x'), 'image/png', 'sec08-dev', 'keepme');
    expect(url).toMatch(/\/uploads\/sec08-dev\/keepme\.png$/);
    expect(leftovers('sec08-dev')).toEqual(['keepme.png']);
    fs.rmSync(path.join(uploadsDir, 'sec08-dev'), { recursive: true, force: true });
    warn.mockRestore();
  });
});

describe('SEC-08: wiring', () => {
  test('multer is only used inside middleware/upload.js, so no route can skip the signature check', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js') && full !== path.join(ROOT, 'src/middleware/upload.js')) {
          if (/require\(['"]multer['"]\)/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  test('KYC storage uses the shared signature check', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/services/kyc-storage.service.js'), 'utf8')).toMatch(/file-signature/);
  });
});
