const axios = require('axios');

module.exports = async function (args) {
    console.log("Transfering call to another agent with args:", args);   
    const url = process.env.AMI_URL || 'http://127.0.0.1:6006';

    return await axios.post(`${url}/transfer`, { uuid: args.uuid, exten: args.transfer_extension || 600, context: args.transfer_context || 'demo', priority: args.transfer_priority || 1 });
  };