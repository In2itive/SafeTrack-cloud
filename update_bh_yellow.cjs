const fs = require('fs');
let content = fs.readFileSync('./components/BatchHistory.tsx', 'utf8');
content = content.replace(/border-yellow-200/g, 'border-yellow-400');
fs.writeFileSync('./components/BatchHistory.tsx', content);
console.log('Done');
