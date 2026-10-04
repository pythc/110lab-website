import Busboy from "busboy";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HonorsError } from "./honors-store.mjs";
import { validateResume } from "./recruitment-files.mjs";
const LIMIT = 5 * 1024 * 1024;
export async function readHonorCertificate(req, { timeoutMs = 60000 } = {}) {
  const fail = (status, message) => new HonorsError(status, message);
  if (Number(req.headers["content-length"] || 0) > LIMIT + 65536)
    throw fail(413, "证书不能超过 5MB");
  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: {
        files: 1,
        fields: 2,
        parts: 4,
        fileSize: LIMIT + 1,
        fieldSize: 128,
        headerPairs: 100,
      },
    });
  } catch {
    throw fail(415, "请通过证书上传组件提交");
  }
  const fields = {},
    chunks = [];
  let info,
    count = 0,
    bytes = 0;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", data);
      req.off("aborted", abort);
      req.off("error", abort);
      if (e) {
        req.unpipe(parser);
        parser.destroy();
        req.resume();
        chunks.length = 0;
        reject(e);
      } else resolve();
    };
    const invalid = () => finish(fail(400, "请上传一份 PDF PNG 或 JPG 证书"));
    const data = (c) => {
      bytes += c.length;
      if (bytes > LIMIT + 65536) finish(fail(413, "证书不能超过 5MB"));
    };
    const abort = () => finish(fail(400, "上传中断 请重试"));
    const timer = setTimeout(
      () => finish(fail(408, "上传超时 请重试")),
      timeoutMs,
    );
    timer.unref();
    req.on("data", data);
    req.once("aborted", abort);
    req.once("error", abort);
    parser.on("field", (name, value, meta) => {
      if (done) return;
      if (
        !["requestId", "revision"].includes(name) ||
        Object.hasOwn(fields, name) ||
        meta.valueTruncated ||
        meta.nameTruncated
      )
        return invalid();
      fields[name] = value;
    });
    parser.on("file", (name, file, meta) => {
      file.on("error", invalid);
      if (done || name !== "certificate" || ++count !== 1) {
        file.resume();
        invalid();
        return;
      }
      info = meta;
      file.on("data", (c) => {
        if (!done) chunks.push(c);
      });
      file.once("limit", () => finish(fail(413, "证书不能超过 5MB")));
    });
    for (const e of ["filesLimit", "fieldsLimit", "partsLimit", "error"])
      parser.on(e, invalid);
    parser.once("close", () => finish());
    req.pipe(parser);
  });
  const f = z
    .object({
      requestId: z.uuid(),
      revision: z.string().regex(/^[1-9]\d{0,8}$/),
    })
    .strict()
    .safeParse(fields);
  if (
    !f.success ||
    !info?.filename ||
    info.filename.length > 180 ||
    /[\u0000-\u001f\u007f/\\]/.test(info.filename)
  )
    throw fail(400, "证书资料无效");
  const buffer = Buffer.concat(chunks);
  const mime = await validateHonorFile(buffer, info.filename, info.mimeType);
  return {
    requestId: f.data.requestId,
    revision: Number(f.data.revision),
    filename: info.filename,
    mime,
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    buffer,
  };
}

export async function validateHonorFile(buffer,filename,mimeType) {
  const fail = (status,message) => new HonorsError(status,message);
  const ext = filename.split(".").at(-1).toLowerCase();
  let mime;
  if (ext === "pdf") {
    await validateResume(buffer, filename, mimeType).catch((e) => {
      throw fail(e.status || 400, "PDF 证书格式无效");
    });
    mime = "application/pdf";
  } else if (
    ext === "png" &&
    buffer.length > 33 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString("ascii", 12, 16) === "IHDR" &&
    buffer.readUInt32BE(16) > 0 &&
    buffer.readUInt32BE(20) > 0
  )
    mime = "image/png";
  else if (
    ["jpg", "jpeg"].includes(ext) &&
    buffer.length > 4 &&
    buffer[0] === 255 &&
    buffer[1] === 216 &&
    buffer[2] === 255 &&
    buffer.at(-2) === 255 &&
    buffer.at(-1) === 217
  )
    mime = "image/jpeg";
  if (
    !mime ||
    !buffer.length ||
    buffer.length > LIMIT ||
    mimeType !== mime
  )
    throw fail(400, "文件内容与 PDF PNG JPG 格式不匹配");
  return mime;
}
