module.exports = {
  networks: {
    local: {
      host: 'localhost',
      port: 8545,
      network_id: '*',
    },
  },
  compilers: {
    solc: {
      version: '^0.5.0',
    },
  },
  plugins: ['truffle-plugin-networks'],
};
