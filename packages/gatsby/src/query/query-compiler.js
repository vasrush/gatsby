// @flow
const _ = require(`lodash`)

const path = require(`path`)
const normalize = require(`normalize-path`)
const glob = require(`glob`)
const levenshtein = require(`fast-levenshtein`)

const {
  validate,
  print,
  visit,
  Kind,
  FieldsOnCorrectTypeRule,
  FragmentsOnCompositeTypesRule,
  KnownArgumentNamesRule,
  KnownDirectivesRule,
  KnownTypeNamesRule,
  LoneAnonymousOperationRule,
  NoFragmentCyclesRule,
  NoUndefinedVariablesRule,
  NoUnusedVariablesRule,
  OverlappingFieldsCanBeMergedRule,
  PossibleFragmentSpreadsRule,
  ProvidedRequiredArgumentsRule,
  ScalarLeafsRule,
  SingleFieldSubscriptionsRule,
  UniqueArgumentNamesRule,
  UniqueDirectivesPerLocationRule,
  UniqueFragmentNamesRule,
  UniqueInputFieldNamesRule,
  UniqueOperationNamesRule,
  UniqueVariableNamesRule,
  ValuesOfCorrectTypeRule,
  VariablesAreInputTypesRule,
  VariablesInAllowedPositionRule,
} = require(`graphql`)

// TODO: Make it a default export in graphql
const {
  ExecutableDefinitions: ExecutableDefinitionsRule,
} = require(`graphql/validation/rules/ExecutableDefinitions`)

const getGatsbyDependents = require(`../utils/gatsby-dependents`)
const { store } = require(`../redux`)
const { actions } = require(`../redux/actions/internal`)
const { default: FileParser } = require(`./file-parser`)
const { graphqlError, multipleRootQueriesError } = require(`./graphql-errors`)
const report = require(`gatsby-cli/lib/reporter`)
const {
  default: errorParser,
  locInGraphQlToLocInFile,
} = require(`./error-parser`)
const websocketManager = require(`../utils/websocket-manager`)

const preValidationRules = [
  LoneAnonymousOperationRule,
  KnownTypeNamesRule,
  FragmentsOnCompositeTypesRule,
  VariablesAreInputTypesRule,
  ScalarLeafsRule,
  PossibleFragmentSpreadsRule,
  ValuesOfCorrectTypeRule,
  VariablesInAllowedPositionRule,
]

const mainValidationRules = [
  ExecutableDefinitionsRule,
  UniqueOperationNamesRule,
  SingleFieldSubscriptionsRule,
  FieldsOnCorrectTypeRule,
  UniqueFragmentNamesRule,
  NoFragmentCyclesRule,
  UniqueVariableNamesRule,
  NoUndefinedVariablesRule,
  NoUnusedVariablesRule,
  KnownDirectivesRule,
  UniqueDirectivesPerLocationRule,
  KnownArgumentNamesRule,
  UniqueArgumentNamesRule,
  ProvidedRequiredArgumentsRule,
  OverlappingFieldsCanBeMergedRule,
  UniqueInputFieldNamesRule,
]

const overlayErrorID = `graphql-compiler`

const resolveThemes = (themes = []) =>
  themes.reduce((merged, theme) => {
    merged.push(theme.themeDir)
    return merged
  }, [])

class Runner {
  base: string
  additional: string[]
  schema: GraphQLSchema
  errors: string[]
  fragmentsDir: string

  constructor(
    base: string,
    additional: string[],
    schema: GraphQLSchema,
    { parentSpan } = {}
  ) {
    this.base = base
    this.additional = additional
    this.schema = schema
    // this.relaySchema = Schema.create(new Source(printSchema(schema)))
    this.parentSpan = parentSpan
  }

  async compileAll(addError) {
    const nodes = await this.parseEverything(addError)
    const results = await this.write(nodes, addError)

    return results
  }

  async parseEverything(addError) {
    const filesRegex = `*.+(t|j)s?(x)`
    // Pattern that will be appended to searched directories.
    // It will match any .js, .jsx, .ts, and .tsx files, that are not
    // inside <searched_directory>/node_modules.
    const pathRegex = `/{${filesRegex},!(node_modules)/**/${filesRegex}}`

    const modulesThatUseGatsby = await getGatsbyDependents()

    let files = [
      path.join(this.base, `src`),
      path.join(this.base, `.cache`, `fragments`),
      ...this.additional.map(additional => path.join(additional, `src`)),
      ...modulesThatUseGatsby.map(module => module.path),
    ].reduce((merged, folderPath) => {
      merged.push(
        ...glob.sync(path.join(folderPath, pathRegex), {
          nodir: true,
        })
      )
      return merged
    }, [])

    files = files.filter(d => !d.match(/\.d\.ts$/))

    files = files.map(normalize)

    // We should be able to remove the following and preliminary tests do suggest
    // that they aren't needed anymore since we transpile node_modules now
    // However, there could be some cases (where a page is outside of src for example)
    // that warrant keeping this and removing later once we have more confidence (and tests)

    // Ensure all page components added as they're not necessarily in the
    // pages directory e.g. a plugin could add a page component. Plugins
    // *should* copy their components (if they add a query) to .cache so that
    // our babel plugin to remove the query on building is active.
    // Otherwise the component will throw an error in the browser of
    // "graphql is not defined".
    files = files.concat(
      Array.from(store.getState().components.keys(), c => normalize(c))
    )

    files = _.uniq(files)

    const parser = new FileParser({ parentSpan: this.parentSpan })

    return await parser.parseFiles(files, addError)
  }

  async write(nodes: Map<string, DocumentNode>, addError): Promise<Queries> {
    const compiledNodes: Queries = new Map()
    const namePathMap = new Map()
    const nameDefMap = new Map()
    const nameErrorMap = new Map()
    const operationDefinitions = []
    const fragmentMap = new Map()

    for (const [filePath, doc] of nodes.entries()) {
      const errors = validate(this.schema, doc, preValidationRules)

      if (errors && errors.length) {
        addError(
          ...errors.map(error => {
            const location = {
              start: locInGraphQlToLocInFile(
                doc.definitions[0].templateLoc,
                error.locations[0]
              ),
            }
            return errorParser({ message: error.message, filePath, location })
          })
        )

        actions.queryExtractionGraphQLError({
          componentPath: filePath,
        })
        return compiledNodes
      }

      // The way we currently export fragments requires duplicated ones
      // to be filtered out since there is a global Fragment namespace
      // We maintain a top level fragment Map to keep track of all definitions
      // of the fragment type and to filter them out if theythey've already been
      // declared before
      doc.definitions = doc.definitions.filter(definition => {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          const fragmentName = definition.name.value
          if (fragmentMap.has(fragmentName)) {
            if (print(definition) === fragmentMap.get(fragmentName).text) {
              return false
            }
          } else {
            fragmentMap.set(fragmentName, {
              def: definition,
              text: print(definition),
            })
          }
        }
        return true
      })

      doc.definitions.forEach((def: any) => {
        const name: string = def.name.value
        namePathMap.set(name, filePath)
        nameDefMap.set(name, def)
        if (def.kind === Kind.OPERATION_DEFINITION) {
          operationDefinitions.push(def)
        }
      })
    }

    const globalDoc = {
      kind: Kind.DOCUMENT,
      definitions: [
        ...operationDefinitions,
        ...Array.from(fragmentMap.values()).map(({ def }) => def),
      ],
    }
    const errors = validate(this.schema, globalDoc, mainValidationRules)
    if (errors && errors.length) {
      for (const error of errors) {
        const { formattedMessage, docName, message, codeBlock } = graphqlError(
          namePathMap,
          nameDefMap,
          error
        )
        nameErrorMap.set(docName, { formattedMessage, message, codeBlock })
        actions.queryExtractionGraphQLError({
          componentPath: namePathMap.get(docName),
          error: formattedMessage,
        })

        const filePath = namePathMap.get(docName)
        addError(errorParser({ message, filePath }))
      }
    }

    const usedFragmentsForFragment = new Map()
    const fragmentNames = Array.from(fragmentMap.keys())

    for (const operation of operationDefinitions) {
      const name = operation.name.value
      const filePath = namePathMap.get(name) || ``
      if (compiledNodes.has(filePath)) {
        const otherNode = compiledNodes.get(filePath)

        addError(
          multipleRootQueriesError(
            filePath,
            nameDefMap.get(name),
            otherNode && nameDefMap.get(otherNode.name)
          )
        )

        actions.queryExtractionGraphQLError({
          componentPath: filePath,
        })
        continue
      }

      const usedFragments = new Set()
      const stack = [operation]
      const missingFragment = false

      while (stack.length > 0) {
        const def = stack.pop(operation)
        visit(def, {
          [Kind.FRAGMENT_SPREAD]: node => {
            const name = node.name.value
            if (usedFragmentsForFragment.has(name)) {
              usedFragmentsForFragment
                .get(name)
                .forEach(derivedFragmentName => {
                  usedFragments.add(derivedFragmentName)
                })
              usedFragments.add(name)
            } else if (fragmentMap.has(name)) {
              stack.push(fragmentMap.get(name).def)
              usedFragments.add(name)
            } else {
              const closestFragment = fragmentNames
                .map(f => {
                  return { fragment: f, score: levenshtein.get(name, f) }
                })
                .filter(f => f.score < 10)
                .sort((a, b) => a.score > b.score)[0]?.fragment

              actions.queryExtractionGraphQLError({
                componentPath: filePath,
              })
              addError({
                id: `85908`,
                filePath,
                context: { fragmentName: name, closestFragment },
              })
            }
          },
        })
      }
      if (missingFragment) {
        continue
      }

      const document = {
        kind: Kind.DOCUMENT,
        definitions: Array.from(usedFragments.values())
          .map(name => fragmentMap.get(name).def)
          .concat([operation]),
      }

      const query = {
        name,
        text: print(document),
        originalText: nameDefMap.get(name).text,
        path: filePath,
        isHook: nameDefMap.get(name).isHook,
        isStaticQuery: nameDefMap.get(name).isStaticQuery,
        hash: nameDefMap.get(name).hash,
      }

      if (query.isStaticQuery) {
        query.id =
          `sq--` +
          _.kebabCase(
            `${path.relative(store.getState().program.directory, filePath)}`
          )
      }

      if (
        query.isHook &&
        process.env.NODE_ENV === `production` &&
        typeof require(`react`).useContext !== `function`
      ) {
        report.panicOnBuild(
          `You're likely using a version of React that doesn't support Hooks\n` +
            `Please update React and ReactDOM to 16.8.0 or later to use the useStaticQuery hook.`
        )
      }

      compiledNodes.set(filePath, query)
    }

    return compiledNodes
  }
}

export { Runner, resolveThemes }

export default async function compile({ parentSpan } = {}): Promise<
  Map<string, RootQuery>
> {
  // TODO: swap plugins to themes
  const { program, schema, themes, flattenedPlugins } = store.getState()

  const activity = report.activityTimer(`extract queries from components`, {
    parentSpan,
    id: `query-extraction`,
  })
  activity.start()

  const runner = new Runner(
    program.directory,
    resolveThemes(
      themes.themes
        ? themes.themes
        : flattenedPlugins.map(plugin => {
            return {
              themeDir: plugin.pluginFilepath,
            }
          })
    ),
    schema,
    { parentSpan: activity.span }
  )

  const errors = []
  const addError = errors.push.bind(errors)

  const queries = await runner.compileAll(addError)

  if (errors.length !== 0) {
    const structuredErrors = activity.panicOnBuild(errors)
    if (process.env.gatsby_executing_command === `develop`) {
      websocketManager.emitError(overlayErrorID, structuredErrors)
    }
  } else {
    if (process.env.gatsby_executing_command === `develop`) {
      // emitError with `null` as 2nd param to clear browser error overlay
      websocketManager.emitError(overlayErrorID, null)
    }
  }
  activity.end()

  return queries
}
