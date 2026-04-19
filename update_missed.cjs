const fs = require('fs');

function replaceInFile(file, replacements) {
  let content = fs.readFileSync(file, 'utf8');
  for (const [search, replace] of replacements) {
    content = content.split(search).join(replace);
  }
  fs.writeFileSync(file, content);
}

replaceInFile('./components/BatchHistory.tsx', [
  ['border-gray-200 text-gray-700 hover:bg-gray-100', 'border-gray-400 text-gray-700 hover:bg-gray-100'],
  ['border-gray-200 text-gray-600 font-bold rounded-lg hover:bg-blue-50', 'border-gray-400 text-gray-600 font-bold rounded-lg hover:bg-blue-50'],
  ['bg-white hover:bg-blue-50 border-gray-200', 'bg-white hover:bg-blue-50 border-gray-400']
]);

replaceInFile('./components/BatchEntry.tsx', [
  ['className="border-gray-200 border rounded-lg p-2 bg-gray-50 text-gray-800"', 'className="border-gray-400 border rounded-lg p-2 bg-gray-50 text-gray-800"'],
  ["'bg-gray-100 text-gray-400 hover:bg-church-100 hover:text-church-500 border-gray-200'", "'bg-gray-100 text-gray-400 hover:bg-church-100 hover:text-church-500 border-gray-400'"],
  ["'bg-white border-gray-200 text-gray-600 hover:border-church-500'", "'bg-white border-gray-400 text-gray-600 hover:border-church-500'"]
]);

replaceInFile('./components/LockScreen.tsx', [
  ["'border-gray-200 bg-gray-50'", "'border-gray-400 bg-gray-50'"]
]);

console.log('Done');
