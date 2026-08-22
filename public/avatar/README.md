# Avatar placement

The canonical user-owned VRM is stored outside the repository:

```text
%USERPROFILE%\.vayria\avatar\model.vrm
```

Each worktree receives a runtime copy at this exact path:

```text
public/avatar/model.vrm
```

`Setup-VayriaWorktree.ps1` copies the canonical VRM when the worktree does not
have a copy. It does not overwrite an existing copy. A missing canonical VRM
only produces a warning, so environment setup can continue without an avatar.

To synchronize the current worktree explicitly:

```powershell
pwsh -NoProfile -File .\scripts\Sync-VayriaAvatar.ps1
```

To synchronize every registered worktree, use `-AllWorktrees`. Existing files
that differ from the canonical VRM remain protected unless `-Force` is used:

```powershell
pwsh -NoProfile -File .\scripts\Sync-VayriaAvatar.ps1 `
  -AllWorktrees -Force
```

The VRM files are intentionally ignored by Git. Do not add them to
`.worktreeinclude`. Reload the browser after adding or replacing a copy.
