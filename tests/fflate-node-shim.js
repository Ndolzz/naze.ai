/* Minimal ZIP reader/writer (STORE method only, UTF-8 names) implementing
   just the fflate calls Naze Code actually uses: zipSync, unzipSync (with
   a `filter` option), strToU8, strFromU8. Used ONLY by the test suite so
   ZIP import/export can be exercised in plain Node without network access
   to install the real fflate package — production code (code-state.js)
   still loads the real fflate library via CDN in index.html. */
'use strict';

function crc32(buf){
  let crc = 0xFFFFFFFF;
  for(let i=0;i<buf.length;i++){
    let c = (crc ^ buf[i]) & 0xFF;
    for(let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
    crc = (crc>>>8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipSync(dataObj){
  const names = Object.keys(dataObj);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  names.forEach(name=>{
    const data = Buffer.from(dataObj[name]);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8);      // method: store
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localOffset = offset;
    localParts.push(localHeader, nameBuf, data);
    offset += localHeader.length + nameBuf.length + data.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBuf);
  });
  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...localParts, central, end]));
}

function unzipSync(u8, opts){
  const buf = Buffer.from(u8);
  const filter = opts && opts.filter;
  const out = {};
  let eocd = buf.length - 22;
  while(eocd>=0 && buf.readUInt32LE(eocd)!==0x06054b50) eocd--;
  if(eocd<0) throw new Error('not a zip');
  const total = buf.readUInt16LE(eocd+10);
  let p = buf.readUInt32LE(eocd+16);
  for(let i=0;i<total;i++){
    if(buf.readUInt32LE(p)!==0x02014b50) break;
    const compSize = buf.readUInt32LE(p+20);
    const uncompSize = buf.readUInt32LE(p+24);
    const nameLen = buf.readUInt16LE(p+28);
    const extraLen = buf.readUInt16LE(p+30);
    const commentLen = buf.readUInt16LE(p+32);
    const localOffset = buf.readUInt32LE(p+42);
    const name = buf.slice(p+46, p+46+nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = buf.readUInt16LE(localOffset+26);
    const lExtraLen = buf.readUInt16LE(localOffset+28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = new Uint8Array(buf.slice(dataStart, dataStart+uncompSize));
    const entry = { name, originalSize: uncompSize };
    if(!filter || filter(entry)) out[name] = data;
  }
  return out;
}

function strToU8(s){ return new Uint8Array(Buffer.from(s, 'utf8')); }
function strFromU8(u8){ return Buffer.from(u8).toString('utf8'); }

module.exports = { zipSync, unzipSync, strToU8, strFromU8 };
