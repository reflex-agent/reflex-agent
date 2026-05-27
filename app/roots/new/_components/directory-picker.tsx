"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { addRootAction } from "@/lib/server/actions";
import { dispatchReflex, REFLEX_EVENTS } from "@/lib/client/events";
import { browseAction, createDirectoryAction } from "./actions";

interface TreeNode {
  name: string;
  absPath: string;
  hidden: boolean;
  loaded: boolean;
  loading: boolean;
  expanded: boolean;
  children: TreeNode[];
}

export function DirectoryPicker({ initialPath }: { initialPath: string }) {
  const t = useTranslations("roots");
  const [rootPath, setRootPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState(initialPath);
  const [showHidden, setShowHidden] = useState(false);
  const [rootLoading, startRootLoading] = useTransition();
  const [adding, startAdding] = useTransition();
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, startCreating] = useTransition();
  const router = useRouter();

  useEffect(() => {
    loadRoot(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRoot = (target: string) => {
    startRootLoading(async () => {
      const res = await browseAction(target);
      if (!res.ok) {
        toast.error(res.error ?? "Failed to browse");
        return;
      }
      setRootPath(res.path);
      setPathInput(res.path);
      setParentPath(res.parent);
      setSelected(res.path);
      setTree(
        res.entries
          .filter((e) => e.isDir)
          .map((e) => makeNode(e.name, e.absPath, e.hidden)),
      );
    });
  };

  const toggle = async (absPath: string) => {
    // Find the node and either expand or collapse. If expanding for the first
    // time, fetch its children.
    const found = findNode(tree, absPath);
    if (!found) return;
    if (found.expanded) {
      setTree((cur) =>
        updateNode(cur, absPath, (n) => ({ ...n, expanded: false })),
      );
      return;
    }
    if (found.loaded) {
      setTree((cur) =>
        updateNode(cur, absPath, (n) => ({ ...n, expanded: true })),
      );
      return;
    }
    setTree((cur) =>
      updateNode(cur, absPath, (n) => ({ ...n, loading: true })),
    );
    const res = await browseAction(absPath);
    if (!res.ok) {
      toast.error(res.error ?? "Failed to browse");
      setTree((cur) =>
        updateNode(cur, absPath, (n) => ({ ...n, loading: false })),
      );
      return;
    }
    const kids = res.entries
      .filter((e) => e.isDir)
      .map((e) => makeNode(e.name, e.absPath, e.hidden));
    setTree((cur) =>
      updateNode(cur, absPath, (n) => ({
        ...n,
        loading: false,
        loaded: true,
        expanded: true,
        children: kids,
      })),
    );
  };

  const onAdd = () => {
    startAdding(async () => {
      const res = await addRootAction(selected);
      if (!res.ok) {
        toast.error(res.error ?? "Failed to add");
        return;
      }
      toast.success("Directory added");
      dispatchReflex(REFLEX_EVENTS.rootsChanged);
      if (res.onboardingTopicId) {
        router.push(`/roots/${res.id}/chat/${res.onboardingTopicId}`);
      } else {
        router.push(`/roots/${res.id}`);
      }
    });
  };

  /** Reload children of `parentAbs` while preserving expanded state. */
  const refreshChildren = async (parentAbs: string) => {
    if (parentAbs === rootPath) {
      const res = await browseAction(parentAbs);
      if (res.ok) {
        setTree(
          res.entries
            .filter((e) => e.isDir)
            .map((e) => makeNode(e.name, e.absPath, e.hidden)),
        );
      }
      return;
    }
    const res = await browseAction(parentAbs);
    if (!res.ok) return;
    const fresh = res.entries
      .filter((e) => e.isDir)
      .map((e) => makeNode(e.name, e.absPath, e.hidden));
    setTree((cur) =>
      updateNode(cur, parentAbs, (n) => ({
        ...n,
        children: fresh,
        loaded: true,
        expanded: true,
      })),
    );
  };

  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    startCreating(async () => {
      const res = await createDirectoryAction(selected, name);
      if (!res.ok) {
        toast.error(res.error ?? t("picker.createFolderFailed"));
        return;
      }
      toast.success(t("picker.folderCreated"));
      setCreatingFolder(false);
      setNewFolderName("");
      await refreshChildren(selected);
      setSelected(res.path);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-4">
          <span>Browse</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadRoot(initialPath)}
            disabled={rootLoading}
          >
            <Home className="mr-1 h-4 w-4" /> Home
          </Button>
        </CardTitle>
        <form
          className="flex gap-2 mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            loadRoot(pathInput);
          }}
        >
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder="/absolute/path"
            className="font-mono text-xs"
          />
          <Button type="submit" variant="secondary" disabled={rootLoading}>
            <RefreshCw
              className={`h-4 w-4 ${rootLoading ? "animate-spin" : ""}`}
            />
          </Button>
        </form>
      </CardHeader>
      <Separator />
      <CardContent className="px-2 py-2">
        <ScrollArea className="h-[460px]">
          <div className="px-2 py-1 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!parentPath || rootLoading}
              onClick={() => parentPath && loadRoot(parentPath)}
              className="h-8"
            >
              <ChevronUp className="mr-1 h-4 w-4" /> Up
            </Button>
            <button
              type="button"
              onClick={() => setSelected(rootPath)}
              className={`flex-1 flex items-center gap-2 px-2 py-1 text-sm rounded-md hover:bg-accent ${
                selected === rootPath ? "bg-accent" : ""
              }`}
              title={rootPath}
            >
              <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate font-mono text-xs">.</span>
              <span className="text-muted-foreground text-[11px] truncate">
                ({basename(rootPath)})
              </span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              disabled={rootLoading || creating}
              onClick={() => {
                setCreatingFolder((v) => !v);
                setNewFolderName("");
              }}
              className="h-8"
              title={t("picker.createFolderTitle", { parent: basename(selected) })}
            >
              <FolderPlus className="mr-1 h-4 w-4" /> {t("picker.createButton")}
            </Button>
            <label className="flex items-center gap-1 text-xs text-muted-foreground select-none">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              hidden
            </label>
          </div>
          {creatingFolder && (
            <form
              className="px-2 pb-2 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitNewFolder();
              }}
            >
              <span className="text-[11px] text-muted-foreground font-mono truncate max-w-[40%]">
                {selected}/
              </span>
              <Input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={t("picker.newFolderPlaceholder")}
                className="h-8 text-sm flex-1"
                disabled={creating}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCreatingFolder(false);
                    setNewFolderName("");
                  }
                }}
              />
              <Button
                type="submit"
                size="sm"
                disabled={creating || !newFolderName.trim()}
                className="h-8"
              >
                {creating ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FolderPlus className="mr-1 h-3.5 w-3.5" />
                )}
                {t("picker.createButton")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreatingFolder(false);
                  setNewFolderName("");
                }}
                className="h-8"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </form>
          )}
          <Separator className="my-1" />
          {rootLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : tree.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No subdirectories.
            </div>
          ) : (
            <TreeView
              nodes={tree}
              selected={selected}
              onSelect={setSelected}
              onToggle={toggle}
              showHidden={showHidden}
              depth={0}
            />
          )}
        </ScrollArea>
      </CardContent>
      <Separator />
      <CardFooter className="flex items-center justify-between gap-4">
        <div className="text-xs text-muted-foreground font-mono truncate">
          Selected: {selected}
        </div>
        <Button onClick={onAdd} disabled={adding || rootLoading}>
          {adding ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Adding…
            </>
          ) : (
            "Add this directory"
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TreeView({
  nodes,
  selected,
  onSelect,
  onToggle,
  showHidden,
  depth,
}: {
  nodes: TreeNode[];
  selected: string;
  onSelect: (p: string) => void;
  onToggle: (p: string) => void;
  showHidden: boolean;
  depth: number;
}) {
  return (
    <ul>
      {nodes
        .filter((n) => showHidden || !n.hidden)
        .map((n) => (
          <li key={n.absPath}>
            <TreeRow
              node={n}
              depth={depth}
              selected={selected}
              onSelect={onSelect}
              onToggle={onToggle}
            />
            {n.expanded && n.children.length > 0 && (
              <TreeView
                nodes={n.children}
                selected={selected}
                onSelect={onSelect}
                onToggle={onToggle}
                showHidden={showHidden}
                depth={depth + 1}
              />
            )}
            {n.expanded && n.loaded && n.children.length === 0 && (
              <div
                className="text-xs text-muted-foreground italic px-2 py-1"
                style={{ paddingLeft: depth * 16 + 44 }}
              >
                (empty)
              </div>
            )}
          </li>
        ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  selected: string;
  onSelect: (p: string) => void;
  onToggle: (p: string) => void;
}) {
  const isSelected = selected === node.absPath;
  return (
    <div
      className={`group flex items-center gap-1 pr-2 py-1 rounded-md hover:bg-accent/60 ${
        isSelected ? "bg-accent" : ""
      }`}
      style={{ paddingLeft: depth * 16 + 4 }}
    >
      <button
        type="button"
        onClick={() => onToggle(node.absPath)}
        className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground shrink-0"
        aria-label={node.expanded ? "Collapse" : "Expand"}
      >
        {node.loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : node.expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onSelect(node.absPath)}
        onDoubleClick={() => onToggle(node.absPath)}
        className="flex-1 min-w-0 flex items-center gap-2 text-left text-sm"
      >
        {node.expanded ? (
          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span className={`truncate ${node.hidden ? "opacity-60" : ""}`}>
          {node.name}
        </span>
      </button>
    </div>
  );
}

function makeNode(name: string, absPath: string, hidden: boolean): TreeNode {
  return {
    name,
    absPath,
    hidden,
    loaded: false,
    loading: false,
    expanded: false,
    children: [],
  };
}

function findNode(nodes: TreeNode[], absPath: string): TreeNode | null {
  for (const n of nodes) {
    if (n.absPath === absPath) return n;
    if (n.expanded) {
      const found = findNode(n.children, absPath);
      if (found) return found;
    }
  }
  return null;
}

function updateNode(
  nodes: TreeNode[],
  absPath: string,
  fn: (n: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((n) => {
    if (n.absPath === absPath) return fn(n);
    if (n.children.length > 0) {
      return { ...n, children: updateNode(n.children, absPath, fn) };
    }
    return n;
  });
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
