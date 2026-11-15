import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, boxes } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('清单中 Period 和 EventStream 原时间尺度保留',()=>{
  const result=inspect(primary);assert.equal(result.periods[0].streams[0].timescale,'1000');
  assert.equal(result.periods[0].streams[0].events[0].id,'7');assert.equal(result.periods[0].segments.length,2);
});
test('两个版本 emsg 有实际 box 边界',async()=>{
  const first=boxes(await resource('/segments/1.m4s'));const second=boxes(await resource('/segments/2.m4s'));
  assert.equal(first[0].type,'emsg');assert.equal(first[0].payload[0],0);assert.equal(second[0].payload[0],1);
});
test('错误 box 长度拒绝，动态两 Period 不丢上下文',async()=>{
  assert.throws(()=>boxes(Buffer.from([0,0,0,9,101,109,115,103])));
  assert.equal(inspect(await resource('/live')).periods.length,2);
});
