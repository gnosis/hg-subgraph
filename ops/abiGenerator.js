const fs = require('fs');
const contract = JSON.parse(fs.readFileSync('node_modules/@gnosis.pm/hg-contracts/build/contracts/PredictionMarketSystem.json', 'utf8'));

fs.writeFileSync('./abis/PredictionMarketSystem.json', JSON.stringify(contract.abi));
console.log(JSON.stringify(contract.abi));