import {config} from 'dotenv';
import {spawnSync} from 'node:child_process';
config({quiet:true});
for(const key of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_MODEL_BUCKET','JWT_SECRET']) {
 const child=spawnSync('vercel.cmd',['env','add',key,'production','--scope','taxme'],{shell:true,input:process.env[key],encoding:'utf8'});
 if(child.status!==0) {console.error('Failed setting '+key+': '+child.stderr);process.exit(1);}
 console.log('Configured '+key);
}
