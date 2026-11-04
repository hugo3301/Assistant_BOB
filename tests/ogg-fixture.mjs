// Container/TOC fixtures; not acoustic recognition samples.
export function ogg(seconds=10,{eos=true,granules=true,channels=1}={}){
 const head=Buffer.alloc(19);head.write('OpusHead');head[8]=1;head[9]=channels;
 const tags=Buffer.alloc(16);tags.write('OpusTags');
 const pages=[];let sequence=0,total=0;
 function page(packets,flags,position){const body=Buffer.concat(packets),header=Buffer.alloc(27+packets.length);header.write('OggS');header[5]=flags;header.writeBigUInt64LE(BigInt(granules?position:0),6);header.writeUInt32LE(42,14);header.writeUInt32LE(sequence++,18);header[26]=packets.length;packets.forEach((packet,index)=>header[27+index]=packet.length);pages.push(Buffer.concat([header,body]));}
 page([head],2,0);page([tags],0,0);
 const count=Math.round(seconds*50);
 for(let index=0;index<count;){const batch=Array.from({length:Math.min(200,count-index)},()=>Buffer.from([0xf8,0xff,0xfe]));index+=batch.length;total+=batch.length*960;page(batch,eos&&index===count?4:0,total);}
 return Buffer.concat(pages);
}
