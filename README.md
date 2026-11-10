# AX Studio

A desktop app for [AX](../ax): design tasks, watch them run, and create local
AX clusters. Built with Electron, React and TypeScript for macOS, Windows and Linux.

![Activity](docs/screenshots/overview.png)

- **Activity:** a sortable task table with running tasks on top, and the
  atespace's workspaces. Resume, suspend or delete tasks, inspect conditions,
  follow logs and delete workspaces.
- **Map:** a graph of sources, workspaces and tasks.
- **Deploy:** build tasks with a form or raw YAML, then create them.
- **Terminal:** sessions into running tasks over `ax ssh`, in tabs that stay
  connected while you use the rest of the app.
- **Clusters:** create, inspect and delete local AX clusters on kind.

| | |
|---|---|
| ![Map](docs/screenshots/topology.png) **Map** | ![Deploy](docs/screenshots/designer.png) **Deploy** |
| ![Terminal](docs/screenshots/terminal.png) **Terminal** | ![Clusters](docs/screenshots/clusters.png) **Clusters** |
| ![Task logs](docs/screenshots/logs.png) **Task logs** | |

The app calls the `ax` CLI and `kubectl`. It passes `--context` on every call,
so it never changes your global context.

### Choose a kubeconfig file

By default, the app reads the `KUBECONFIG` of its launcher, else `~/.kube/config`.
To read another file, open **Clusters**. The **Kubeconfig** card at the top
shows the files in use, their contexts, and the source of the choice. Press
**Browse…** to select a file. Press **Use default** to restore the launch
default.

You can also open **Settings** and type the path in the
**Kubeconfig** field. The field accepts more than one file, joined by the path
separator of the platform (`;` on Windows, `:` elsewhere). A `~` at the start
of a path expands to your home directory.

The app sets `KUBECONFIG` for its own `ax` and `kubectl` calls only. Your
shell and your own kubeconfig do not change. The app saves the choice and
reads it again at the next start. When a chosen file does not exist, the card
and the Settings dialog show the file in red.

#### Kubeconfig files in WSL (Windows)

On Windows, the **Kubeconfig** card has an **Add from WSL…** button. It lists
the WSL distros and the kubeconfig files in each distro: `$KUBECONFIG` of the
login shell, `~/.kube/*`, `/tmp/kubeconfig*`, and each `kubeconfig*` file in
your home directory. Each entry shows its contexts. Press **Use** to replace
the choice with that file, or **Add** to append it.

The app stores a WSL file as a UNC path, for example
`\\wsl.localhost\Ubuntu\home\<user>\.kube\config`. A path that starts with
`/` also counts as a WSL path, in the default distro. When the choice contains
a WSL file, the app runs each `ax`, `kubectl`, and setup step inside that
distro with `wsl.exe -d <distro> --exec /bin/sh -lc`. `KUBECONFIG` is set in
the distro to the Linux paths. Windows drive paths in the same choice become
`/mnt/<drive>/...`.

Because the commands run in Linux, exec plugins such as
`aws eks get-token` work with the WSL login and tools. The app reads the file
list only. It does not read the file contents.

## Develop

```sh
npm install
npm run dev         # hot-reloading app
npm run typecheck
```

To refresh a screenshot, build (`npm run build`) and run:

```sh
npx electron . --section=clusters --cluster=ax-dev --delay=7000 --screenshot=docs/screenshots/clusters.png
```

Other flags: `--context`, `--atespace`, `--task`, `--logs=expanded`, `--terminal=<command>`.

## Package

```sh
npm run dist:mac    # .dmg and .zip
npm run dist:win    # NSIS installer and .zip
npm run dist:linux  # AppImage, .deb, .tar.gz
```

Build each OS on that OS. macOS builds are unsigned; set `mac.identity` in
`electron-builder.yml` to sign. To regenerate the icon on macOS:

```sh
swift scripts/make-icon.swift ~/ax/assets/axel.svg build-resources/icon.icns
```

## Clusters

> [!NOTE]
> Cluster creation is a prototype. Ideally, once AX Studio is installed on a
> laptop, it won't need any external dependencies.

Creating a cluster runs the AX repo's `hack/setup-e2e-kind.sh`, which needs
`make`, `go` and `docker` or `podman`. The app then merges the `kind-<name>`
context into your kubeconfig and saves a `.ax-studio.bak` backup. Reinstalling
AX deletes existing tasks and workspaces.

With podman and no docker, the app uses a `docker` shim
([docker-shim.sh](src/main/docker-shim.sh)).

## Platform notes

- **macOS/Linux:** the app reads PATH from your login shell.
- **Windows:** cluster setup needs Git for Windows (`bash`), `make` and `go`.
