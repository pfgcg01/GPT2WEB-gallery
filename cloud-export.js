// Assemble verified original files in the browser, outside serverless response
// size limits. Deliberately bounded to 200 MB; no resizing or transcoding.
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc=bytes=>{let value=0xffffffff;for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);return (value^0xffffffff)>>>0;};
export async function cloudZip(entries,{fetch:request=fetch,progress=()=>{}}={}){
  if(!Array.isArray(entries)||!entries.length||entries.length>500||entries.reduce((n,e)=>n+e.size,0)>200*1024*1024)throw Error('一次最多匯出 500 張／200 MB。');
  const local=[],central=[];let offset=0,count=0;
  for(const entry of entries){
    if(!/^[a-f0-9]{64}$/u.test(entry.id)||!Number.isSafeInteger(entry.size)||entry.size<1||entry.name.includes('..')||entry.name.startsWith('/')||entry.name.includes('\\'))throw Error('匯出清單不正確。');
    const url=new URL(entry.url);if(url.protocol!=='https:'||!/^[-a-z0-9]+\.supabase\.co$/iu.test(url.hostname)||!url.pathname.startsWith('/storage/v1/object/sign/'))throw Error('原檔下載位址不正確。');
    progress(`正在核對原檔 ${++count}／${entries.length}…`);
    const response=await request(url.href,{credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error('原檔下載中斷，請重新匯出。');
    const reader=response.body.getReader(),chunks=[];let length=0;for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>entry.size){await reader.cancel();throw Error('原檔長度不符。');}chunks.push(value);}if(length!==entry.size)throw Error('原檔尚未完整下載。');
    const data=new Uint8Array(length);let position=0;for(const chunk of chunks){data.set(chunk,position);position+=chunk.length;}
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');if(digest!==entry.id)throw Error('原檔 SHA-256 不符，沒有匯出未核對的 ZIP。');
    const name=new TextEncoder().encode(entry.name),checksum=crc(data),header=new Uint8Array(30),h=new DataView(header.buffer);h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(12,33,true);h.setUint32(14,checksum,true);h.setUint32(18,length,true);h.setUint32(22,length,true);h.setUint16(26,name.length,true);
    const directory=new Uint8Array(46),d=new DataView(directory.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,0x0a14,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);d.setUint32(16,checksum,true);d.setUint32(20,length,true);d.setUint32(24,length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);
    local.push(header,name,new Blob([data]));central.push(directory,name);offset+=header.length+name.length+length;
  }
  const centralSize=central.reduce((sum,part)=>sum+part.byteLength,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
export async function saveCloudZip(entries,progress){const blob=await cloudZip(entries,{progress}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`GPT2WEB-selected-${Date.now()}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);progress(`已核對 ${entries.length} 張原檔，請查看瀏覽器下載。`);}
