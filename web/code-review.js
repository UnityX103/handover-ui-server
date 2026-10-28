// Optional review panels use the existing question/answer and saved-receipt workflow.
const handoverCodeDisclosure = new Map();
const handoverCodeSending = new Set();
const handoverCodeErrors = new Map();

function handoverReviewElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// This is display-only highlighting: source is always inserted as text, never executed.
function handoverCodeTokens(source, language) {
  if (language === 'text') return [{text:source,kind:''}];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%)?|\b[A-Za-z_$][\w$-]*\b/g;
  const keywords = new Set('abstract as async await base bool boolean break byte case catch char class const continue decimal default delegate delete do double else enum event export extends false finally float for foreach from function get if implements import in int interface internal is let lock long namespace new null number object of out override partial private protected public readonly record ref return sealed set short static string struct super switch this throw true try typeof undefined using var virtual void while yield'.split(' '));
  const result = []; let end = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > end) result.push({text:source.slice(end,match.index),kind:''});
    const text = match[0], tail = source.slice(match.index+text.length);
    const kind = text.startsWith('/*') || text.startsWith('//') ? 'comment'
      : /^["'`]/.test(text) ? 'string'
      : /^\d/.test(text) ? 'number'
      : language === 'css' && /^\s*:/.test(tail) ? 'property'
      : keywords.has(text) ? 'keyword'
      : /^\s*\(/.test(tail) ? 'function'
      : /^[A-Z]/.test(text) ? 'type' : '';
    result.push({text,kind}); end = match.index+text.length;
  }
  if (end < source.length) result.push({text:source.slice(end),kind:''});
  return result;
}

function handoverReviewCode(source, file, side) {
  const pane = handoverReviewElement('div','review-code review-code-'+side);
  pane.tabIndex = 0; pane.setAttribute('role','region'); pane.setAttribute('aria-label',file.path+' · '+(side === 'after' ? '修改后' : '修改前'));
  const lines = [[]];
  for (const token of handoverCodeTokens(source,file.language)) {
    const parts = token.text.split('\n');
    parts.forEach((part,index) => { if (index) lines.push([]); if (part) lines[lines.length-1].push({text:part,kind:token.kind}); });
  }
  lines.forEach((tokens,index) => {
    const row = handoverReviewElement('div','review-code-line');
    const number = handoverReviewElement('span','review-code-number',String(file.startLine+index)); number.setAttribute('aria-hidden','true');
    const code = handoverReviewElement('code','review-source');
    for (const token of tokens) code.append(handoverReviewElement('span',token.kind ? 'review-token-'+token.kind : '',token.text));
    row.append(number,code); pane.append(row);
  });
  return pane;
}

function handoverRenderCodeReview(main, question) {
  const review = question?.codeReview;
  if (!main || !review) return;
  const key = question.id+':'+review.digest;
  const section = handoverReviewElement('section','handover-code-review');
  section.setAttribute('aria-label','需要修改的代码');
  section.append(handoverReviewElement('div','review-eyebrow','需要修改的代码 · 版本 '+review.revision));
  section.append(handoverReviewElement('h3','review-title',review.summary));
  if (review.expected) {
    const figure = handoverReviewElement('figure','review-expected');
    figure.append(handoverReviewElement('figcaption','review-expected-summary','预期效果 · '+review.expected.summary));
    const frame = handoverReviewElement('iframe','review-expected-frame');
    frame.title = '修改后的预期效果'; frame.setAttribute('sandbox','allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.loading = 'lazy';
    frame.src = withToken('/review-preview?q='+encodeURIComponent(question.id)+'&digest='+encodeURIComponent(review.digest));
    figure.append(frame); section.append(figure);
  }
  for (const [index,file] of review.files.entries()) {
    const details = handoverReviewElement('details','review-file');
    const fileKey = key+':file:'+index;
    details.open = handoverCodeDisclosure.get(fileKey) ?? index === 0;
    details.addEventListener('toggle',() => { if (details.isConnected) handoverCodeDisclosure.set(fileKey,details.open); });
    const summary = handoverReviewElement('summary','review-file-summary');
    summary.append(handoverReviewElement('span','review-file-path',file.path),handoverReviewElement('span','review-file-location','第 '+file.startLine+' 行起'));
    details.append(summary,handoverReviewElement('p','review-file-reason',file.summary));
    if (file.before) {
      const before = handoverReviewElement('details','review-before');
      const beforeKey = key+':before:'+index;
      before.open = handoverCodeDisclosure.get(beforeKey) || false;
      before.addEventListener('toggle',() => { if (before.isConnected) handoverCodeDisclosure.set(beforeKey,before.open); });
      before.append(handoverReviewElement('summary','','查看修改前'),handoverReviewCode(file.before,file,'before'));
      details.append(before);
    }
    details.append(handoverReviewElement('div','review-after-label',(file.before ? '修改后' : '新增代码')+' · '+file.language),handoverReviewCode(file.after,file,'after'));
    section.append(details);
  }
  const actions = handoverReviewElement('div','review-actions');
  const approve = handoverReviewElement('button','primary','批准并发送');
  const revise = handoverReviewElement('button','','需要调整');
  approve.type = revise.type = 'button';
  const disabled = locked() || sendState(false).disabled || handoverCodeSending.has(key);
  approve.disabled = revise.disabled = disabled;
  const decide = async decision => {
    if (handoverCodeSending.has(key) || locked() || sendState(false).disabled) return;
    handoverCodeSending.add(key); approve.disabled = revise.disabled = true;
    handoverCodeErrors.delete(key);
    try {
      stageAnswer(question.id,{kind:'text',text:(decision === 'approve' ? '批准这项修改：' : '这项修改需要调整：')+review.summary,review:{id:review.id,revision:review.revision,digest:review.digest,decision}});
      await send();
      if (local.staged[question.id]?.answer?.review) handoverCodeErrors.set(key,document.getElementById('send-why').textContent || '反馈尚未保存，请重试。');
    } catch (error) {
      handoverCodeErrors.set(key,error.message || '反馈尚未保存，请重试。');
    } finally { handoverCodeSending.delete(key); if (handoverSessionActive() && !handoverReturning) render(); }
  };
  approve.onclick = () => decide('approve'); revise.onclick = () => decide('revise');
  actions.append(approve,revise);
  if (handoverCodeErrors.has(key)) {
    const error = handoverReviewElement('p','review-error',handoverCodeErrors.get(key)); error.setAttribute('role','alert'); section.append(error);
  }
  section.append(actions,handoverReviewElement('p','review-decision-note','按当前版本反馈，连同已暂存的内容发送给 Agent。'));
  main.append(section);
}

if (typeof buildActions === 'function') {
  const handoverOriginalBuildActions = buildActions;
  buildActions = function(...args) {
    const actions = handoverOriginalBuildActions(...args);
    for (const action of actions) {
      const review = action.type === 'answer' && local.staged[action.q]?.answer?.review;
      if (review) action.review = {...review};
    }
    return actions;
  };
}
