import { config } from '../server/config.js';
import { createUser,findUserByEmail } from '../server/db/database.js';
import { writeFileSync } from 'node:fs';
if(!await findUserByEmail(config.seedAdminEmail)) {
 await createUser({email:config.seedAdminEmail,password:config.seedAdminPassword,role:'admin',forcePasswordReset:true});
 writeFileSync('.deployment-access.txt', `BUILD//IT administrator\nEmail: ${config.seedAdminEmail}\nTemporary password: ${config.seedAdminPassword}\nChange your password at first login.\n`);
 console.log('Administrator created; credentials saved locally.');
} else console.log('Administrator already exists.');
