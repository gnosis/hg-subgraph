# Hg Subgraph

Subgraph for Gnosis Conditional Tokens

---

## Deployment Instructions

Before the subgraph can be deployed to the main graph node, you must create the ABIs, setup the _network_ and _address_ fields in the `subgraph.yaml`, and make sure to create and deploy to the right subgraph name. Below are the steps to do this:

1.  git clone https://github.com/gnosis/hg-subgraph.git && cd hg-subgraph

2.  npm install

3.  npm run refresh-abi

4.  node ops/set-deployment-environment [network][address]

    You can also alternatively set the network and address in a .env file as envrionment variables.

5.  create the subgraph name desired in `package.json` under the `create` and `deploy` scripts.

6. npm run codegen

7. npm run build

6.  npm run create

7.  npm run deploy

---

## Testing instructions

All the testing needs to be run in a fresh isolated Docker environment. To run the tests, run this command:
`npm run create-test-pipeline`

---
