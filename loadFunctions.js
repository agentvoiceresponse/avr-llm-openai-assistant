const fs = require('fs');
const path = require('path');

/**
 * Gets the handler for a specific function
 * @param {string} name - Name of the function
 * @returns {Function} function handler
 * @throws {Error} If the function is not found
 */
function getFunctionHandler(name) {
  // Possible paths for the function file
  const possiblePaths = [
    path.join(__dirname, 'avr_functions', `${name}.js`),  // First check in avr_functions
    path.join(__dirname, 'functions', `${name}.js`)       // Then check in functions
  ];

  // Find the first valid path
  const functionPath = possiblePaths.find(path => fs.existsSync(path));
  
  if (!functionPath) {
    throw new Error(`function "${name}" not found in any available directory`);
  }

  return require(functionPath)
}

module.exports = { getFunctionHandler };