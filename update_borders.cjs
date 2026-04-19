const fs = require('fs');
const path = require('path');

const dir = './components';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.tsx'));

files.forEach(file => {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  const lines = content.split('\n');
  let inTag = false;
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    if (line.match(/<(input|button|select|textarea)/)) {
      inTag = true;
    }
    
    if (inTag) {
      if (line.includes('border-gray-200')) lines[i] = lines[i].replace(/border-gray-200/g, 'border-gray-400');
      if (line.includes('border-gray-300')) lines[i] = lines[i].replace(/border-gray-300/g, 'border-gray-500');
      if (line.includes('border-gray-100')) lines[i] = lines[i].replace(/border-gray-100/g, 'border-gray-300');
      if (line.includes('border-red-100')) lines[i] = lines[i].replace(/border-red-100/g, 'border-red-300');
      if (line.includes('border-red-200')) lines[i] = lines[i].replace(/border-red-200/g, 'border-red-400');
      if (line.includes('border-blue-100')) lines[i] = lines[i].replace(/border-blue-100/g, 'border-blue-300');
      if (line.includes('border-blue-200')) lines[i] = lines[i].replace(/border-blue-200/g, 'border-blue-400');
      if (line.includes('border-green-100')) lines[i] = lines[i].replace(/border-green-100/g, 'border-green-300');
      if (line.includes('border-green-200')) lines[i] = lines[i].replace(/border-green-200/g, 'border-green-400');
      if (line.includes('border-yellow-100')) lines[i] = lines[i].replace(/border-yellow-100/g, 'border-yellow-300');
      if (line.includes('border-yellow-200')) lines[i] = lines[i].replace(/border-yellow-200/g, 'border-yellow-400');
    }
    
    if (line.match(/>/) && inTag && !line.match(/<[^>]*$/)) {
      inTag = false;
    }
    if (line.match(/\/>/)) {
      inTag = false;
    }
    if (line.match(/<\/(input|button|select|textarea)>/)) {
      inTag = false;
    }
  }
  
  fs.writeFileSync(filePath, lines.join('\n'));
});
console.log('Done');
