const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// Only shared code and dependencies need to be visible outside the app. Private root data and backend source do not.
config.watchFolders = [path.join(workspaceRoot, 'packages', 'contracts'), path.join(workspaceRoot, 'node_modules')]
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules'), path.join(workspaceRoot, 'node_modules')]
config.resolver.disableHierarchicalLookup = true
config.resolver.useWatchman = false

// Metro merges regex sources and requires matching flags. Character classes retain case protection without /i.
const insensitiveName = (name) =>
    Array.from(name, (character) => {
        if (character >= 'a' && character <= 'z') {
            return `[${character}${character.toUpperCase()}]`
        }

        return character === '.' ? '\\.' : character
    }).join('')
const privateNames = ['.local', '.private', 'uploads', 'provider-responses', 'provider_responses']
    .map(insensitiveName)
    .join('|')
const privatePaths = new RegExp(`(^|[/\\\\])(?:${privateNames}|${insensitiveName('.env')}(?:\\.[^/\\\\]*)?)([/\\\\]|$)`)
const inheritedBlocks = config.resolver.blockList
config.resolver.blockList = [
    ...(Array.isArray(inheritedBlocks) ? inheritedBlocks : inheritedBlocks ? [inheritedBlocks] : []),
    privatePaths,
]

module.exports = config
