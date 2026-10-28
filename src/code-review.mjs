import { hash } from './store.mjs';

export const codeReviewLimits = Object.freeze({version:1,maxFiles:12,maxCodeBytes:200000,maxPreviewBytes:500000});
const invalid = message => { throw Object.assign(new Error(message), {status:400}); };
const string = (value,max) => typeof value === 'string' && value.length <= max;

// A digest binds a decision to the exact files, snippets and visual being reviewed.
export function prepareCodeReviews(state, previous) {
  for (const question of state.questions) {
    const input = question.codeReview;
    if (input === undefined) continue;
    if (!input || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !string(input.summary,1000) || !input.summary.trim()) invalid('代码修改需要 id、正整数 revision 和一句话 summary');
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > codeReviewLimits.maxFiles) invalid('代码修改应包含 1–12 个文件片段');
    let bytes = 0;
    const files = input.files.map(file => {
      if (!file || !string(file.path,2000) || !file.path.trim() || !string(file.summary,1000) || !file.summary.trim() || !string(file.before,codeReviewLimits.maxCodeBytes) || !string(file.after,codeReviewLimits.maxCodeBytes) || !Number.isSafeInteger(file.startLine) || file.startLine < 1 || !['text','css','html','javascript','typescript','csharp','json','python'].includes(file.language)) invalid('代码片段需要 path、summary、startLine、language、before 和 after');
      bytes += Buffer.byteLength(file.before) + Buffer.byteLength(file.after);
      return {path:file.path,summary:file.summary,startLine:file.startLine,language:file.language,before:file.before,after:file.after};
    });
    if (bytes > codeReviewLimits.maxCodeBytes) invalid('代码修改片段过大');
    const review = {id:input.id,revision:input.revision,summary:input.summary,files};
    if (input.expected !== undefined) {
      const expected = input.expected;
      if (!expected || !string(expected.summary,1000) || !expected.summary.trim() || !string(expected.html,codeReviewLimits.maxPreviewBytes) || !expected.html.trim() || Buffer.byteLength(expected.html) > codeReviewLimits.maxPreviewBytes) invalid('预期效果需要简短说明及大小受限的自包含 HTML');
      review.expected = {summary:expected.summary,html:expected.html};
    }
    review.digest = hash(JSON.stringify(review));
    const old = previous?.questions.find(item => item.id === question.id)?.codeReview;
    if (old?.id === review.id && (review.revision < old.revision || review.revision === old.revision && review.digest !== old.digest)) invalid('代码修改内容已变化，请递增 revision 后重新提交批准');
    question.codeReview = review;
  }
  return state;
}

export function validateReviewDecision(action, question) {
  if (action.review === undefined) return;
  const decision = action.review, review = question?.codeReview;
  if (action.type !== 'answer' || action.kind !== 'text' || !decision || !['approve','revise'].includes(decision.decision)) invalid('代码修改决定应为明确的文字答复及 approve/revise');
  if (!review || decision.id !== review.id || decision.revision !== review.revision || decision.digest !== review.digest) throw Object.assign(new Error('修改方案已更新，请重新查看效果和代码后再批准'), {status:409});
}

export const codePreviewCsp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
