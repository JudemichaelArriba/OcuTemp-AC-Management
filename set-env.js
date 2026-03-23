const fs = require('fs');
const path = require('path');


if (fs.existsSync('.env') && fs.readFileSync('.env', 'utf8').trim().length > 0) {
  require('dotenv').config();
}

const cacheDir = path.join(__dirname, '.angular', 'cache');
if (fs.existsSync(cacheDir)) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}


const baseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_ID,
  appId: process.env.FIREBASE_APP_ID
};


const environments = {


  'src/environments/environment.ts': `
export const environment = {
  production: false,
  firebase: {
    apiKey: '${baseConfig.apiKey}',
    authDomain: '${baseConfig.authDomain}',
    databaseURL: '${baseConfig.databaseURL}',
    projectId: '${baseConfig.projectId}',
    storageBucket: '${baseConfig.storageBucket}',
    messagingSenderId: '${baseConfig.messagingSenderId}',
    appId: '${baseConfig.appId}'
  }
};`,


  'src/environments/environment.development.ts': `
export const environment = {
  production: false,
  firebase: {
    apiKey: '${baseConfig.apiKey}',
    authDomain: '${baseConfig.authDomain}',
    databaseURL: '${baseConfig.databaseURL}',
    projectId: '${baseConfig.projectId}',
    storageBucket: '${baseConfig.storageBucket}',
    messagingSenderId: '${baseConfig.messagingSenderId}',
    appId: '${baseConfig.appId}'
  }
};`,


  'src/environments/environment.prod.ts': `
export const environment = {
  production: true,
  firebase: {
    apiKey: '${baseConfig.apiKey}',
    authDomain: '${baseConfig.authDomain}',
    databaseURL: '${baseConfig.databaseURL}',
    projectId: '${baseConfig.projectId}',
    storageBucket: '${baseConfig.storageBucket}',
    messagingSenderId: '${baseConfig.messagingSenderId}',
    appId: '${baseConfig.appId}'
  }
};`

};


Object.entries(environments).forEach(([filePath, content]) => {
  fs.writeFileSync(filePath, content.trim());
});

