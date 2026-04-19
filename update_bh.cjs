const fs = require('fs');
let content = fs.readFileSync('./components/BatchHistory.tsx', 'utf8');
const tagRegex = /<(button|input|select|textarea|label)\b([^>]*?)>/g;
content = content.replace(tagRegex, (match, tagName, attributes) => {
  let newAttributes = attributes.replace(/hover:border-blue-200/g, 'hover:border-blue-400');
  return `<${tagName}${newAttributes}>`;
});
fs.writeFileSync('./components/BatchHistory.tsx', content);
console.log('Done');
