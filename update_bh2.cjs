const fs = require('fs');
let content = fs.readFileSync('./components/BatchHistory.tsx', 'utf8');
content = content.replace(/hover:border-blue-200/g, 'hover:border-blue-400');
fs.writeFileSync('./components/BatchHistory.tsx', content);
console.log('Done');
