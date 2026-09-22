import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { assembleFeishuFileContext, type FileContextMessage } from '../src/services/feishu-file-context.js';
import { parseFeishuAttachment } from '../src/services/feishu-attachment-parser.js';

describe('Feishu attachment parsing', () => {
  it('extracts readable text from markdown and html without returning markup', async () => {
    await expect(parseFeishuAttachment(Buffer.from('# 方向\n先做买家报告'), 'text/markdown', 'plan.md'))
      .resolves.toBe('# 方向\n先做买家报告');
    await expect(parseFeishuAttachment(Buffer.from('<h1>方向</h1><p>先做买家报告 &amp; 工作台</p>'), 'text/html', 'plan.html'))
      .resolves.toBe('方向\n先做买家报告 & 工作台');
  });

  it('extracts paragraph text from docx and shared strings from xlsx entirely in memory', async () => {
    const docx=new JSZip();docx.file('word/document.xml','<w:document xmlns:w="w"><w:p><w:r><w:t>交付买家报告</w:t></w:r></w:p><w:p><w:r><w:t>James review</w:t></w:r></w:p></w:document>');
    const xlsx=new JSZip();xlsx.file('xl/sharedStrings.xml','<sst><si><t>Floorplan</t></si><si><t>已完成</t></si></sst>');
    await expect(parseFeishuAttachment(await docx.generateAsync({type:'nodebuffer'}),'application/vnd.openxmlformats-officedocument.wordprocessingml.document','brief.docx'))
      .resolves.toBe('交付买家报告\nJames review');
    await expect(parseFeishuAttachment(await xlsx.generateAsync({type:'nodebuffer'}),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','status.xlsx'))
      .resolves.toBe('Floorplan\n已完成');
  });

  it('lists safe archive entries but does not recursively execute or expand their contents', async () => {
    const zip=new JSZip();zip.file('readme.md','do not parse me');zip.file('../escape.txt','bad');
    await expect(parseFeishuAttachment(await zip.generateAsync({type:'nodebuffer'}),'application/zip','bundle.zip'))
      .resolves.toBe('归档文件目录：\nreadme.md');
  });

  it('rejects unsupported or oversized attachments before parsing', async () => {
    await expect(parseFeishuAttachment(Buffer.from('x'),'application/pdf','x.pdf')).rejects.toThrow('ATTACHMENT_TYPE_UNSUPPORTED');
    await expect(parseFeishuAttachment(Buffer.alloc(21),'text/plain','x.txt',{maxBytes:20})).rejects.toThrow('ATTACHMENT_TOO_LARGE');
  });

  it('rejects a compressed office document whose declared expanded XML exceeds the bound', async()=>{
    const docx=new JSZip();docx.file('word/document.xml','<w:t>123456789012345678901</w:t>');
    await expect(parseFeishuAttachment(await docx.generateAsync({type:'nodebuffer'}),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document','large.docx',{maxBytes:1000,maxExpandedBytes:20}))
      .rejects.toThrow('ATTACHMENT_EXPANDED_TOO_LARGE');
  });
});

describe('Feishu file context assembly', () => {
  const message=(id:string,minutes:number,text:string,threadId:string|null=null):FileContextMessage=>({
    messageId:id,occurredAt:new Date(Date.parse('2026-09-10T10:00:00Z')+minutes*60_000).toISOString(),
    text,messageType:'text',senderType:'user',threadId,rootId:null
  });

  it('combines the attachment with up to three nearby user messages on each side and same-thread replies', () => {
    const messages=[message('old',-40,'太早'),message('p1',-10,'背景一'),message('p2',-5,'背景二'),
      {...message('file',0,''),messageType:'file' as const},message('n1',5,'结论一'),message('n2',10,'结论二'),
      message('thread',90,'线程补充','t1'),message('bot',1,'机器人',null)];
    messages[3]!.threadId='t1';messages[7]!.senderType='app';
    const result=assembleFeishuFileContext({file:{messageId:'file',title:'方案.md',mimeType:'text/markdown',text:'文件中的方案'},messages});
    expect(result.contentText).toContain('文件中的方案');
    expect(result.contextMessageIds).toEqual(['p1','p2','n1','n2','thread']);
    expect(result.contentText).not.toContain('太早');
    expect(result.contentText).not.toContain('机器人');
  });

  it('keeps file text transient and bounded in the returned analysis source', () => {
    const result=assembleFeishuFileContext({file:{messageId:'file',title:'方案.md',mimeType:'text/markdown',text:'1234567890'},
      messages:[{...message('file',0,''),messageType:'file'}],maxChars:24});
    expect(result.contentText.length).toBeLessThanOrEqual(24);
    expect(result.sourceType).toBe('group_message');
  });
});
