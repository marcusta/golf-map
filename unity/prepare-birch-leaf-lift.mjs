// Lift the birch canopy: the fir/pine/birch pass left Birch Leaves at 0.22/0.37/0.38,
// the darkest foliage in the project (elm/poplar sit at 0.44/0.56/0.49, pine at 0.52/0.65/0.61).
// Optional arguments override the colours, e.g. `.5,.62,.5 .46,.57,.45`.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage,healthy='.50,.62,.50',dry='.46,.57,.45']=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE [HEALTHY_RGB] [DRY_RGB]');
const rgb=t=>{const v=t.split(',').map(Number);if(v.length!==3||v.some(n=>!(n>=0&&n<=1)))throw Error('Bad colour '+t);return v;};
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const set=(t,key,v)=>{const re=new RegExp('(^    - '+key+': \{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}','m');if(!re.test(t))throw Error('Missing '+key);return t.replace(re,(_,p,a)=>p+v[0]+', g: '+v[1]+', b: '+v[2]+', a: '+a+'}');};
const file='Assets/GolfMap/Vreta/FoliageTrialV2/Birch Leaves.mat';
const before=read(file);
const after=set(set(before,'_HealthyColor',rgb(healthy)),'_DryColor',rgb(dry));
if(after===before)throw Error('Birch leaves already at these colours');
save(file,after);
const show=t=>t.match(/^    - _(?:Healthy|Dry)Color:.*$/gm).join(' ').trim();
const report={file,before:show(before),after:show(after)};
save('report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
