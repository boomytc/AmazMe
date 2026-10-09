# AmazMe Packages

## Native plugins

The default interactive CLI loads Chord session facets. Install and select them with the existing package manager:

```bash
amazme install npm:@example/amazme-plugin@1.0.0
amazme install git:github.com/example/amazme-plugin@v1
amazme install ./local-plugin
amazme -e npm:@example/amazme-plugin@1.0.0
```

A native package declares `chord.facets.session` or provides `src/session.ts`. Native loading builds only that role. Package settings, project precedence, `autoload: false` deltas and `extensions` filters use the existing package selection rules. Filters select the session source file; `extensions: []` disables it. `/plugins` shows the actual loaded source, and `/reload` rebuilds the selected sources. Changes to package declarations or source selection require a restart.

See [Plugin execution and reload](plugin-runtime.md) for the native contract and local path/glob selection. The SDK resource manifest described below is used by Print/RPC and SDK sessions; it does not turn SDK extension factories into native facets.

## SDK resources

AmazMe packages install and distribute extensions, skills, prompt templates, and themes as one unit. Use a package when a customization should be shared through npm or git, or when several resources belong together.

A package is an ordinary directory or npm package. It can expose conventional resource directories, declare explicit paths under the `pi` key in `package.json`, and carry its own runtime dependencies.

## Install and manage packages

Install from npm, git, or a local path:

```bash
amazme install npm:@example/pi-tools@1.0.0
amazme install git:github.com/example/pi-tools@v1
amazme install ./local-package
```

`amazme list` shows configured packages. Use `amazme remove <source>` to remove one and `amazme update --extensions` to reconcile package installations. See [Command Line](cli.md#package-commands) for every package command and option.

Personal installs are written to `~/.amazme/agent/settings.json`. Add `--local` or `-l` to write the package declaration to `.amazme/settings.json`. AmazMe reads declarations from that file only after project trust is granted.

Project packages are installed and loaded only after project trust is resolved. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it. Review project package declarations before granting project trust.

Use `--extension` or `-e` to try a package for one invocation without adding it to settings:

```bash
amazme -e npm:@example/pi-tools
```

## Choose a source

| Source | Example | Behavior |
|---|---|---|
| npm | `npm:@example/pi-tools@1.0.0` | Installed under the AmazMe npm directory |
| git | `git:github.com/example/pi-tools@v1` | Cloned and reconciled to the selected ref |
| URL | `https://github.com/example/pi-tools` | Treated as a git source |
| Local | `./pi-tools` | Loaded from the resolved path without copying |

Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates reconcile the checkout but do not move a configured ref.

Relative local paths resolve from the settings file that contains them. A file path loads one extension. A directory follows normal package discovery rules.

## Create a package

The simplest package uses conventional directories:

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

Without a `pi` manifest, SDK sessions discover TypeScript and JavaScript extensions, skill directories, Markdown prompts, and JSON themes from those directories.

Use an explicit manifest when resources live elsewhere or need filtering:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Paths are relative to the package root. Arrays accept glob patterns and exclusions. List dot-prefixed or symlinked resource roots directly when traversal through a glob would not discover them.

The `pi-package` keyword makes an npm package eligible for discovery in the [Pi package gallery](https://pi.dev/packages). Optional `pi.image` and `pi.video` fields add gallery previews.

## Declare dependencies

Put runtime packages imported by extensions in `dependencies`. AmazMe installs package dependencies when it installs an npm or git source.

SDK sessions supply these packages to extensions and skills:

- `@amazme/ai`
- `@amazme/agent`
- `@amazme/coding-agent`
- `@amazme/tui`
- `typebox`

Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not bundle them. AmazMe suppresses automatic peer installation for managed npm packages and git packages installed with npm, pnpm, or Bun. Local packages are not installed or modified, so their dependency tree remains the package author's responsibility.

Do not list host-provided packages in `dependencies`. A physical copy can bypass the SDK extension module mapping in compiled ESM and create duplicate classes, registries, and initialization work. The SDK reports an extension warning when it detects this manifest configuration. Other packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths.

Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package’s undeclared dependency.

## Select package resources

The object form in settings narrows which resources load from a package:

```json
{
  "packages": [
    {
      "source": "npm:@example/pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

For each resource type:

- Omit the property to load everything allowed by the package.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude glob matches.
- Use `+path` to include one exact allowed path.
- Use `-path` to exclude one exact path.

Filters narrow the package manifest. They do not expose resources that the package itself did not declare.

Run `amazme config` to enable or disable discovered resources and the SDK built-in extensions. It starts with personal configuration; press Tab to switch scope, or run `amazme config --local` to start with project overrides.

## Understand scope and identity

The same package can appear in personal and project settings. A project entry normally replaces the personal entry. With `autoload: false`, the project entry instead acts as a filtering delta over the personal package.

AmazMe identifies npm packages by package name, git packages by repository URL without the ref, and local packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Themes](themes.md) to design each resource before packaging it.
