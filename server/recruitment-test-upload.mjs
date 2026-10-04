import Busboy from 'busboy';
import {z} from 'zod';
import {validateResume} from './recruitment-files.mjs';
import {RecruitmentTestError} from './recruitment-test-store.mjs';

export const TEST_RESUME_LIMIT = 10 * 1024 * 1024;
const fieldsSchema = z.object({requestId: z.uuid(), revision: z.string().regex(/^[1-9]\d{0,8}$/)}).strict();

// At most two authenticated uploads are admitted by the HTTP adapter. Files
// stay in bounded memory until validation succeeds, leaving no temp orphans.
export async function readTestResume(req, {timeoutMs = 60000} = {}) {
  if (Number(req.headers['content-length'] || 0) > TEST_RESUME_LIMIT + 65536) {
    throw new RecruitmentTestError(413, '简历不能超过 10MB');
  }
  let parser;
  try {
    parser = Busboy({headers: req.headers, defParamCharset: 'utf8', limits: {
      files: 1, fields: 2, parts: 4, fileSize: TEST_RESUME_LIMIT + 1,
      fieldSize: 128, headerPairs: 100,
    }});
  } catch { throw new RecruitmentTestError(415, '请通过简历上传组件提交文件'); }
  const fields = {}, chunks = [];
  let info, bytes = 0, fileCount = 0;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('aborted', onAbort);
      req.off('error', onAbort);
      if (error) {
        req.unpipe(parser);
        parser.destroy();
        req.resume();
        chunks.length = 0;
        reject(error);
      } else resolve();
    };
    const invalid = () => finish(new RecruitmentTestError(400, '请上传一份 PDF 或 DOCX 测试简历'));
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > TEST_RESUME_LIMIT + 65536) finish(new RecruitmentTestError(413, '简历不能超过 10MB'));
    };
    const onAbort = () => finish(new RecruitmentTestError(400, '上传中断 请重试'));
    const timer = setTimeout(() => finish(new RecruitmentTestError(408, '上传超时 请重试')), timeoutMs);
    timer.unref();
    req.on('data', onData);
    req.once('aborted', onAbort);
    req.once('error', onAbort);
    parser.on('field', (name, value, meta) => {
      if (done) return;
      if (!['requestId', 'revision'].includes(name) || Object.hasOwn(fields, name) || meta.valueTruncated || meta.nameTruncated) return invalid();
      fields[name] = value;
    });
    parser.on('file', (name, file, meta) => {
      file.on('error', invalid);
      if (done || name !== 'resume' || ++fileCount !== 1) { file.resume(); invalid(); return; }
      info = meta;
      file.on('data', chunk => { if (!done) chunks.push(chunk); });
      file.once('limit', () => finish(new RecruitmentTestError(413, '简历不能超过 10MB')));
    });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit', 'error']) parser.on(event, invalid);
    parser.once('close', () => finish());
    req.pipe(parser);
  });
  const parsed = fieldsSchema.safeParse(fields);
  if (!info || !parsed.success || !info.filename || info.filename.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(info.filename)) {
    throw new RecruitmentTestError(400, '上传资料无效 请重新选择简历');
  }
  const buffer = Buffer.concat(chunks);
  let metadata;
  try { metadata = await validateResume(buffer, info.filename, info.mimeType); }
  catch (error) { throw new RecruitmentTestError(error.status || 400, error.message); }
  return {requestId: parsed.data.requestId, revision: Number(parsed.data.revision), filename: info.filename, buffer, ...metadata};
}
