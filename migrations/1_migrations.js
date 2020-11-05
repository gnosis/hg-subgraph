module.exports = (d) => {
  d.then(async () => {
    const netId = await web3.eth.net.getId();
    const conditionalTokensAddress = require('@gnosis.pm/conditional-tokens-contracts/build/contracts/ConditionalTokens.json')
      .networks[netId].address;
    const realitioAddress = require('@realitio/realitio-contracts/truffle/build/contracts/Realitio.json')
      .networks[netId].address;

    await d.deploy(
      artifacts.require('RealitioProxy'),
      conditionalTokensAddress,
      realitioAddress,
      5
    );
    await d.deploy(
      artifacts.require('RealitioScalarAdapter'),
      conditionalTokensAddress,
      realitioAddress
    );
  });
};
