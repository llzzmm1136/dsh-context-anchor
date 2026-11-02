import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
let definition;const entries=[];const effects=[]
const React={Component:class{},createElement:(type,props,...children)=>({type,props,children}),useState:x=>[x,()=>{}],useRef:x=>({current:x}),useEffect:f=>effects.push(f)}
const source=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8')
vm.runInNewContext(source,{window:{__ModuleLoader__:{load:d=>{assert.equal(definition,undefined);definition=d}}},console,fetch:async()=>({ok:false}),setInterval:()=>1,clearInterval(){}})
definition.factory(name=>{assert.equal(name,'react');return React}).apply({effect:f=>f(),slots:{inject:(_,f)=>f(),register:(options,component)=>entries.push({options,component})}})
for(const id of ['balance','balance-panel','context-anchor-cache','context-anchor-panel'])assert.equal(entries.filter(e=>e.options.id===id).length,1,id)
assert.equal(definition.id,'@local/dsh-context-anchor')
assert.ok(!source.includes("require('react-dom')"))
assert.ok(source.includes('24 小时合计'))
const panel=entries.find(e=>e.options.id==='balance-panel').component
assert.equal(panel(),null)
console.log('PASS one client module registers both dock entries and overlay panels without react-dom')
