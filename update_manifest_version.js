const fs = require('fs')

const packageJson = JSON.parse(fs.readFileSync('package.json'))
const manifestJson = JSON.parse(fs.readFileSync('manifest.konnector'))

manifestJson.version = packageJson.version

fs.writeFileSync('manifest.konnector', JSON.stringify(manifestJson, null, 2))
