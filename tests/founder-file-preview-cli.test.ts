import { expect, it } from 'vitest';
import { parseFilePreviewArguments, parsePreviewAttachment } from '../src/cli/preview-founder-work-map-with-files.js';

it('accepts only the approved group and a bounded output preview request',()=>{
  const base=['--chat-id','oc_a84d5b6ca478220d0a37964b50776edb','--since','2026-08-31T20:04:00.338Z','--until','2026-09-20T20:04:00.338Z',
    '--ivy-open-id','ou_ivy','--james-open-id','ou_james','--output','/tmp/preview.json'];
  expect(parseFilePreviewArguments(base)).toMatchObject({output:'/tmp/preview.json'});
  expect(()=>parseFilePreviewArguments(base.map(value=>value==='oc_a84d5b6ca478220d0a37964b50776edb'?'oc_other':value))).toThrow('FILE_PREVIEW_ARGUMENTS_INVALID');
});

it('records an unsupported attachment as unavailable instead of aborting the preview',async()=>{
  await expect(parsePreviewAttachment(Buffer.from('%PDF'), 'application/pdf', 'brief.pdf', 20*1024*1024))
    .resolves.toEqual({status:'text_unavailable',reason:'ATTACHMENT_TYPE_UNSUPPORTED'});
});
