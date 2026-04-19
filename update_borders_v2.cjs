const fs = require('fs');
const path = require('path');

const dir = './components';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.tsx'));

files.forEach(file => {
  const filePath = path.join(dir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Match tags like <button ...>, <input ...>, <select ...>, <textarea ...>, <label ...>
  // We'll use a regex that matches the opening tag and its attributes until the > or />
  const tagRegex = /<(button|input|select|textarea|label)\b([^>]*?)>/g;
  
  content = content.replace(tagRegex, (match, tagName, attributes) => {
    // Inside the attributes, replace the border classes
    let newAttributes = attributes
      .replace(/border-gray-200/g, 'border-gray-400')
      .replace(/border-gray-300/g, 'border-gray-500')
      .replace(/border-gray-100/g, 'border-gray-300')
      .replace(/border-red-100/g, 'border-red-300')
      .replace(/border-red-200/g, 'border-red-400')
      .replace(/border-blue-100/g, 'border-blue-300')
      .replace(/border-blue-200/g, 'border-blue-400')
      .replace(/border-green-100/g, 'border-green-300')
      .replace(/border-green-200/g, 'border-green-400')
      .replace(/border-yellow-100/g, 'border-yellow-300')
      .replace(/border-yellow-200/g, 'border-yellow-400');
      
    return `<${tagName}${newAttributes}>`;
  });
  
  fs.writeFileSync(filePath, content);
});
console.log('Done');
