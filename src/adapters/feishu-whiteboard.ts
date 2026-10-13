import { randomUUID } from 'node:crypto';
import type { FounderWhiteboardGateway, FounderWhiteboardNode } from '../services/founder-whiteboard.js';

interface FeishuResponse<T = unknown> { code?:number;msg?:string;data?:T }
export interface FeishuWhiteboardSdkLike {
  docx:{v1:{
    document:{create(input:{data:{title:string}}):Promise<FeishuResponse<{document?:{document_id?:string}}>>};
    documentBlockChildren:{create(input:{path:{document_id:string;block_id:string};data:{children:Array<{
      block_type:number;board:{align:number;width:number;height:number}
    }>}}):Promise<FeishuResponse<{children?:Array<{board?:{token?:string;whiteboard_id?:string}}>}>>};
  }};
  board:{v1:{whiteboardNode:{create(input:{path:{whiteboard_id:string};data:{nodes:FounderWhiteboardNode[]};
    params?:{client_token?:string}}):Promise<FeishuResponse<{ids?:string[]}>>}}};
  drive:{v1:{permissionMember:{create(input:{path:{token:string};params:{type:'docx';need_notification:false};data:{
    member_type:'openchat';member_id:string;perm:'edit';perm_type:'container'
  }}):Promise<FeishuResponse>}}};
}

const nodeBatchSize=50;

export function createFeishuWhiteboardGateway(sdk:FeishuWhiteboardSdkLike):FounderWhiteboardGateway {
  return {
    async createDocument(input){
      const response=await sdk.docx.v1.document.create({data:{title:input.title}});
      assertSuccess(response,'create document');
      const documentId=response.data?.document?.document_id?.trim();
      if(!documentId)throw new Error('Feishu whiteboard document id is missing');
      return{documentId};
    },
    async createBoard(input){
      const response=await sdk.docx.v1.documentBlockChildren.create({
        path:{document_id:input.documentId,block_id:input.documentId},
        data:{children:[{block_type:43,board:{align:1,width:input.width,height:input.height}}]}
      });
      assertSuccess(response,'create board block');
      const board=response.data?.children?.[0]?.board;
      const whiteboardId=(board?.token??board?.whiteboard_id)?.trim();
      if(!whiteboardId)throw new Error('Feishu whiteboard id is missing');
      return{whiteboardId};
    },
    async createNodes(input){
      for(let offset=0;offset<input.nodes.length;offset+=nodeBatchSize){
        const response=await sdk.board.v1.whiteboardNode.create({
          path:{whiteboard_id:input.whiteboardId},data:{nodes:[...input.nodes.slice(offset,offset+nodeBatchSize)]},
          params:{client_token:randomUUID()}
        });
        assertSuccess(response,'create whiteboard nodes');
      }
    },
    async grantGroupEdit(input){
      const response=await sdk.drive.v1.permissionMember.create({
        path:{token:input.documentId},params:{type:'docx',need_notification:false},
        data:{member_type:'openchat',member_id:input.chatId,perm:'edit',perm_type:'container'}
      });
      assertSuccess(response,'grant group edit access');
    }
  };
}

function assertSuccess(response:FeishuResponse,operation:string):void{
  if(response.code!==undefined&&response.code!==0){
    throw new Error(`Feishu ${operation} failed (${response.code}): ${response.msg??'unknown error'}`);
  }
}
