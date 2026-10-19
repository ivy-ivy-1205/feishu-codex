import JSZip from 'jszip';

export interface FeishuAttachmentParseOptions { maxBytes?: number; maxChars?: number; maxExpandedBytes?: number }

const docxMime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const xlsxMime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function parseFeishuAttachment(
  body: Buffer,
  mimeType: string,
  title: string,
  options: FeishuAttachmentParseOptions={}
): Promise<string> {
  const maxBytes=options.maxBytes??20*1024*1024,maxChars=options.maxChars??180_000;
  if(body.byteLength>maxBytes)throw new Error('ATTACHMENT_TOO_LARGE');
  const type=mimeType.split(';')[0]!.trim().toLowerCase();
  const maxExpandedBytes=options.maxExpandedBytes??20*1024*1024;let text:string;
  if(type==='text/markdown'||type==='text/plain'||/\.(md|txt)$/iu.test(title))text=body.toString('utf8');
  else if(type==='text/html'||/\.html?$/iu.test(title))text=htmlText(body.toString('utf8'));
  else if(type===docxMime||/\.docx$/iu.test(title))text=await docxText(body,maxExpandedBytes);
  else if(type===xlsxMime||/\.xlsx$/iu.test(title))text=await xlsxText(body,maxExpandedBytes);
  else if(type==='application/zip'||/\.zip$/iu.test(title))text=await archiveListing(body);
  else throw new Error('ATTACHMENT_TYPE_UNSUPPORTED');
  return normalize(text).slice(0,maxChars);
}

async function docxText(body:Buffer,maxExpandedBytes:number):Promise<string>{
  const zip=await JSZip.loadAsync(body),entry=zip.file('word/document.xml');assertExpandedBound(entry,maxExpandedBytes);
  const xml=await entry?.async('string');
  if(!xml)throw new Error('ATTACHMENT_CONTENT_INVALID');
  return xml.replace(/<w:tab\b[^>]*\/>/giu,'\t').replace(/<w:br\b[^>]*\/>/giu,'\n')
    .replace(/<\/w:p>/giu,'\n').replace(/<[^>]+>/gu,'');
}

async function xlsxText(body:Buffer,maxExpandedBytes:number):Promise<string>{
  const zip=await JSZip.loadAsync(body),sharedEntry=zip.file('xl/sharedStrings.xml');assertExpandedBound(sharedEntry,maxExpandedBytes);
  const shared=await sharedEntry?.async('string');
  if(shared)return [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)].map(match=>match[1]!.replace(/<[^>]+>/gu,'')).join('\n');
  const sheets=Object.keys(zip.files).filter(name=>/^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort();
  return (await Promise.all(sheets.map(async name=>{const entry=zip.file(name)!;assertExpandedBound(entry,maxExpandedBytes);
    return (await entry.async('string')).replace(/<[^>]+>/gu,' ')}))).join('\n');
}

function assertExpandedBound(entry:JSZip.JSZipObject|null,max:number):void{
  const size=(entry as unknown as {_data?:{uncompressedSize?:unknown}}|null)?._data?.uncompressedSize;
  if(typeof size==='number'&&size>max)throw new Error('ATTACHMENT_EXPANDED_TOO_LARGE');
}

async function archiveListing(body:Buffer):Promise<string>{
  const zip=await JSZip.loadAsync(body);
  const names=Object.values(zip.files).filter(entry=>!entry.dir&&!entry.unsafeOriginalName?.includes('..'))
    .map(entry=>entry.name).filter(name=>!name.startsWith('/')&&!name.includes('../')).sort().slice(0,200);
  return `归档文件目录：\n${names.join('\n')}`;
}

function htmlText(value:string):string{
  return decodeEntities(value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu,'')
    .replace(/<\/?(h[1-6]|p|div|li|tr|br)\b[^>]*>/giu,'\n').replace(/<[^>]+>/gu,'').replace(/\n{2,}/gu,'\n'));
}

function decodeEntities(value:string):string{return value.replace(/&nbsp;/giu,' ').replace(/&amp;/giu,'&')
  .replace(/&lt;/giu,'<').replace(/&gt;/giu,'>').replace(/&quot;/giu,'"').replace(/&#39;/giu,"'")}
function normalize(value:string):string{return decodeEntities(value).replace(/\r\n?/gu,'\n').replace(/[ \t]+\n/gu,'\n')
  .replace(/\n{3,}/gu,'\n\n').trim()}
