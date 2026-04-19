const fs = require('fs');
let content = fs.readFileSync('./components/BatchEntry.tsx', 'utf8');
content = content.replace(/border-red-200/g, 'border-red-400');
fs.writeFileSync('./components/BatchEntry.tsx', content);
console.log('Done');
