import {Buffer} from 'node:buffer';
import {requireThat} from './errors.mjs';
import {FREE_POLICY} from './control.mjs';

const format=(ok)=>requireThat(ok,'VOICE_FORMAT','Не получилось прочитать голосовое. Запись повреждена или имеет неподдерживаемый формат. Попробуй отправить заново.');
function packetSamples(packet){
 format(packet.length>0);
 const config=packet[0]>>3,code=packet[0]&3;
 const frame=config<12?[480,960,1920,2880][config%4]:config<16?[480,960][config%2]:[120,240,480,960][config%4];
 const count=code===0?1:code<3?2:(packet[1]??0)&63;
 format((code!==3||packet.length>=2)&&count>0&&frame*count<=5760);
 return frame*count;
}

// A missing EOS flag describes the container, not acoustic silence. Determine
// playable duration from complete Opus packets; granules supply normal end trim.
export function inspectOpus(bytes){
 const buffer=Buffer.from(bytes);let offset=0,serial=null,sequence=null,preSkip=null,channels=null,granule=0n,samples=0,packets=0,pages=0,eos=false,parts=[],pending=0;
 format(buffer.length>0&&buffer.length<=FREE_POLICY.voiceBytes);
 while(offset<buffer.length){
  format(!eos&&offset+27<=buffer.length&&buffer.toString('ascii',offset,offset+4)==='OggS'&&buffer[offset+4]===0);
  const flags=buffer[offset+5],segments=buffer[offset+26],header=27+segments;
  format(!(flags&~7)&&offset+header<=buffer.length&&Boolean(flags&1)===Boolean(pending));
  const currentSerial=buffer.readUInt32LE(offset+14),currentSequence=buffer.readUInt32LE(offset+18);
  if(serial===null){serial=currentSerial;format(Boolean(flags&2));}else format(serial===currentSerial&&!(flags&2)&&currentSequence===((sequence+1)>>>0));
  sequence=currentSequence;let cursor=offset+header;
  for(let index=0;index<segments;index++){
   const length=buffer[offset+27+index];format(cursor+length<=buffer.length);
   parts.push(buffer.subarray(cursor,cursor+length));cursor+=length;pending+=length;
   if(length===255)continue;
   const packet=Buffer.concat(parts);parts=[];pending=0;
   if(packets===0){format(packet.length>=19&&packet.toString('ascii',0,8)==='OpusHead'&&packet[8]<=15&&[1,2].includes(packet[9])&&packet[18]===0);preSkip=packet.readUInt16LE(10);channels=packet[9];}
   else if(packets===1)format(packet.length>=16&&packet.toString('ascii',0,8)==='OpusTags');
   else samples+=packetSamples(packet);
   packets++;
   requireThat(samples/48000<=FREE_POLICY.voiceSeconds+0.25,'VOICE_LENGTH','Голосовое длиннее 2 минут. Раздели его на несколько коротких сообщений.');
  }
  const position=buffer.readBigUInt64LE(offset+6);
  if(position!==0xffffffffffffffffn){format(position>=granule);granule=position;}
  eos=Boolean(flags&4);offset=cursor;pages++;
 }
 format(!pending&&parts.length===0&&preSkip!==null);
 requireThat(packets>2&&samples>preSkip,'VOICE_EMPTY','В записи не удалось найти аудиоданные. Попробуй отправить голосовое заново.');
 // Some recorders omit final granules as well as EOS. Packet duration is bounded
 // independently of Telegram metadata, so neither can bypass the two-minute cap.
 const played=granule>BigInt(preSkip)&&granule<=BigInt(samples)?Number(granule)-preSkip:samples-preSkip;
 const seconds=played/48000;
 requireThat(seconds<=FREE_POLICY.voiceSeconds+0.1,'VOICE_LENGTH','Голосовое длиннее 2 минут. Раздели его на несколько коротких сообщений.');
 return{seconds,channels,pages,audioPackets:packets-2,eos,hasGranule:granule>BigInt(preSkip)};
}
export const opusDuration=bytes=>inspectOpus(bytes).seconds;
