// Change only EOS in locally synthesized test audio, preserving Ogg checksums.
import {readFileSync,writeFileSync} from 'node:fs';
import {inspectOpus} from '../src/ogg-opus.mjs';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Supply synthetic input and output OGG paths');
const bytes=readFileSync(input);let offset=0;
while(offset<bytes.length){const count=bytes[offset+26],end=offset+27+count+bytes.subarray(offset+27,offset+27+count).reduce((sum,n)=>sum+n,0);bytes[offset+5]&=~4;bytes.writeUInt32LE(0,offset+22);let crc=0;for(let pos=offset;pos<end;pos++){crc^=bytes[pos]<<24;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&0x80000000)?0x04c11db7:0))>>>0;}bytes.writeUInt32LE(crc>>>0,offset+22);offset=end;}
writeFileSync(output,bytes);console.log(JSON.stringify({synthetic:true,...inspectOpus(bytes)}));
