import {
  ILabShell,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { InputDialog, WidgetTracker } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { PartialJSONValue, Token } from '@lumino/coreutils';
import { YFile, YNotebook } from '@jupyterlab/shared-models';
import { Awareness } from 'y-protocols/awareness';
import { getIdentity } from './utils';
import { CommentPanel, ICommentPanel } from './panel';
import { CommentWidget } from './widget';
import { Cell } from '@jupyterlab/cells';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { CommentRegistry, ICommentRegistry } from './registry';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { DocumentRegistry, DocumentWidget } from '@jupyterlab/docregistry';
import {
  CellCommentFactory,
  CellSelectionCommentFactory,
  TestCommentFactory,
  TextSelectionCommentFactory
} from './factory';
import { Menu } from '@lumino/widgets';
import { CommentFileModelFactory, ICommentOptions } from './model';
import { ICellComment } from './commentformat';
import { CodeEditorWrapper } from '@jupyterlab/codeeditor';


namespace CommandIDs {
  export const addComment = 'jl-comments:add-comment';
  export const deleteComment = 'jl-comments:delete-comment';
  export const editComment = 'jl-comments:edit-comment';
  export const replyToComment = 'jl-comments:reply-to-comment';
  export const addNotebookComment = 'jl-comments:add-notebook-comment';
}

const ICommentRegistry = new Token<ICommentRegistry>(
  'jupyterlab-comments:comment-registry'
);

export type CommentTracker = WidgetTracker<CommentWidget<any>>;

/**
 * A plugin that provides a `CommentRegistry`
 */
export const commentRegistryPlugin: JupyterFrontEndPlugin<ICommentRegistry> = {
  id: 'jupyterlab-comments:registry',
  autoStart: true,
  provides: ICommentRegistry,
  activate: (app: JupyterFrontEnd) => {
    return new CommentRegistry();
  }
};

const ICommentPanel = new Token<ICommentPanel>(
  'jupyterlab-comments:comment-panel'
);

// const ICommentTracker = new Token<CommentTracker>(
//   'jupyterlab-comments:comment-tracker'
// );

/**
 * A plugin that allows notebooks to be commented on.
 */
const notebookCommentsPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-comments:plugin',
  autoStart: true,
  requires: [INotebookTracker, ICommentPanel, ICommentRegistry],
  activate: (
    app: JupyterFrontEnd,
    nbTracker: INotebookTracker,
    panel: ICommentPanel,
    registry: ICommentRegistry
  ) => {
    void registry.addFactory(new CellCommentFactory(nbTracker));
    void registry.addFactory(new CellSelectionCommentFactory(nbTracker));

    let currAwareness: Awareness | null = null;

    const indicator = Private.createIndicator(panel, nbTracker);

    // This updates the indicator and scrolls to the comments of the selected cell
    // when the active cell changes.
    nbTracker.activeCellChanged.connect((_, cell: Cell | null) => {
      if (cell == null) {
        if (indicator.parentElement != null) {
          indicator.remove();
        }
        return;
      }

      const model = panel.model;
      if (model == null) {
        return;
      }

      for (let comment of model.comments) {
        if (comment.type === 'cell' || comment.type === 'cell-selection') {
          const cellComment = comment as ICellComment;
          if (cellComment.target.cellID === cell.model.id) {
            panel.scrollToComment(cellComment.id);
            break;
          }
        }
      }

      const awarenessHandler = (): void => {
        const { start, end } = cell.editor.getSelection();

        if (start.column !== end.column || start.line !== end.line) {
          if (!cell.node.contains(indicator)) {
            cell.node.childNodes[1].appendChild(indicator);
          }
        } else if (indicator.parentElement != null) {
          indicator.remove();
        }
      };

      if (currAwareness != null) {
        currAwareness.off('change', awarenessHandler);
      }

      currAwareness = (nbTracker.currentWidget!.model!.sharedModel as YNotebook)
        .awareness;
      currAwareness.on('change', awarenessHandler);
    });

    app.commands.addCommand(CommandIDs.addNotebookComment, {
      label: 'Add Cell Comment',
      execute: () => {
        const cell = nbTracker.activeCell;
        if (cell == null) {
          return;
        }

        void InputDialog.getText({
          title: 'Enter Comment'
        }).then(value => {
          if (value.value == null) {
            return;
          }

          const model = panel.model!;
          model.addComment({
            source: cell,
            text: value.value,
            identity: getIdentity(model.awareness),
            type: 'cell'
          });

          panel.update();
        });
      }
    });

    app.contextMenu.addItem({
      command: CommandIDs.addNotebookComment,
      selector: '.jp-Notebook .jp-Cell',
      rank: 13
    });
  }
};

export const jupyterCommentingPlugin: JupyterFrontEndPlugin<ICommentPanel> = {
  id: 'jupyterlab-comments:commenting-api',
  autoStart: true,
  requires: [ICommentRegistry, ILabShell, IDocumentManager, IRenderMimeRegistry],
  provides: ICommentPanel,
  activate: (
    app: JupyterFrontEnd,
    registry: ICommentRegistry,
    shell: ILabShell,
    docManager: IDocumentManager,
    renderer: IRenderMimeRegistry
  ): CommentPanel => {
    const filetype: DocumentRegistry.IFileType = {
      contentType: 'file',
      displayName: 'comment',
      extensions: ['.comment'],
      fileFormat: 'json',
      name: 'comment',
      mimeTypes: ['application/json']
    };

    const commentTracker = new WidgetTracker<CommentWidget<any>>({
      namespace: 'comment-widgets'
    });

    const editorTracker = new WidgetTracker<CodeEditorWrapper>({
      namespace: 'code-editor-wrappers'
    });

    void registry.addFactory(new TestCommentFactory());
    void registry.addFactory(new TextSelectionCommentFactory({type: 'text-selection'}, editorTracker));

    const panel = new CommentPanel({
      commands: app.commands,
      registry,
      docManager,
      shell
    },
    renderer);

    // Create the directory holding the comments.
    void panel.pathExists(panel.pathPrefix).then(exists => {
      const contents = docManager.services.contents;
      if (!exists) {
        void contents
          .newUntitled({
            path: '/',
            type: 'directory'
          })
          .then(model => {
            void contents.rename(model.path, panel.pathPrefix);
          });
      }
    });

    addCommands(app, commentTracker, panel);

    const commentMenu = new Menu({ commands: app.commands });
    commentMenu.addItem({ command: CommandIDs.deleteComment });
    commentMenu.addItem({ command: CommandIDs.editComment });
    commentMenu.addItem({ command: CommandIDs.replyToComment });

    const modelFactory = new CommentFileModelFactory({
      registry,
      commentMenu
    });

    app.docRegistry.addFileType(filetype);
    app.docRegistry.addModelFactory(modelFactory);

    // Add the panel to the shell's right area.
    shell.add(panel, 'right', { rank: 600 });

    // panel.revealed.connect(() => panel.update());
    shell.currentChanged.connect((_, args) => {
      if (args.newValue != null && args.newValue instanceof DocumentWidget) {
        const docWidget = args.newValue as DocumentWidget;
        const path = docWidget.context.path;
        if (path !== '') {
          void panel.loadModel(docWidget.context.path);
        }
      }
    });

    let currAwareness: Awareness | null = null;

    //commenting stuff for non-notebook/json files
    shell.currentChanged.connect((_, changed) => {
      if(changed.newValue == null) {
        return;
      }

      let invalids = ['json', 'ipynb'];
      let editorWidget = ((changed.newValue as DocumentWidget).content as CodeEditorWrapper);
      if(invalids.includes(changed.newValue.title.label.split(".").pop()!) || editorWidget.editor == null) {
        return;
      }
      console.log("NEW TITLE: ", editorWidget.title.label);
      if(!editorTracker.has(editorWidget)) {
        console.warn('new document!')
        editorTracker.add(editorWidget);
      }
      editorWidget.editor.focus();

      editorWidget.node.oncontextmenu = () => {
        void InputDialog.getText({title: 'Enter Comment'}).then(value => 
        panel.model?.addComment({
          type: 'text-selection',
          text: value.value ?? 'invalid!',
          source: editorWidget,
          identity: getIdentity(panel.model.awareness)
        }));
      }

      const handler = () : void => {
        
      }

      if(currAwareness != null) {
        currAwareness.off('change', handler);
      }

      currAwareness = (editorWidget.editor.model.sharedModel as YFile).awareness;
      currAwareness.on('change', handler);
      
    });

    panel.modelChanged.connect((_, fileWidget) => {
      if (fileWidget != null) {
        fileWidget.commentAdded.connect(
          (_, commentWidget) => void commentTracker.add(commentWidget)
        );
      }
    });

    // app.commands.addCommand('addComment', {
    //   label: 'Add Document Comment',
    //   execute: () => {
    //     const model = panel.model!;
    //     model.addComment({
    //       text: UUID.uuid4(),
    //       type: 'test',
    //       target: null,
    //       identity: randomIdentity()
    //     });
    //     panel.update();
    //   },
    //   isEnabled: () => panel.model != null
    // });

    // app.commands.addCommand('saveCommentFile', {
    //   label: 'Save Comment File',
    //   execute: () => void panel.fileWidget!.context.save(),
    //   isEnabled: () => panel.model != null
    // });

    // app.contextMenu.addItem({
    //   command: 'addComment',
    //   selector: '.lm-Widget',
    //   rank: 0
    // });

    // app.contextMenu.addItem({
    //   command: 'saveCommentFile',
    //   selector: '.lm-Widget',
    //   rank: 1
    // });

    return panel;
  }
};

function addCommands(
  app: JupyterFrontEnd,
  commentTracker: CommentTracker,
  panel: ICommentPanel
): void {
  app.commands.addCommand(CommandIDs.addComment, {
    label: 'Add Comment',
    execute: async args => {
      const model = panel.model;
      if (model == null) {
        return;
      }
      if (!('target' in args && args.target != null)) {
        return;
      }

      void InputDialog.getText({
        title: 'Enter Comment'
      }).then(value => {
        if (value.value != null) {
          const { target, type, source } = args;
          let comment: ICommentOptions;
          if (source != null) {
            comment = {
              type: type as string,
              text: value.value,
              identity: getIdentity(model.awareness),
              source
            };
          } else if (target != null) {
            comment = {
              type: type as string,
              text: value.value,
              identity: getIdentity(model.awareness),
              target: target as PartialJSONValue
            };
          } else {
            return;
          }

          model.addComment(comment);

          panel.update();
        }
      });
    }
  });

  app.commands.addCommand(CommandIDs.deleteComment, {
    label: 'Delete Comment',
    execute: () => {
      const currentComment = commentTracker.currentWidget;
      if (currentComment != null) {
        currentComment.deleteActive();
        panel.update();
      }
    }
  });

  app.commands.addCommand(CommandIDs.editComment, {
    label: 'Edit Comment',
    execute: () => {
      const currentComment = commentTracker.currentWidget;
      if (currentComment != null) {
        currentComment.openEditActive();
      }
    }
  });

  app.commands.addCommand(CommandIDs.replyToComment, {
    label: 'Reply to Comment',
    execute: () => {
      const currentComment = commentTracker.currentWidget;
      if (currentComment != null) {
        currentComment.revealReply();
      }
    }
  });
}

namespace Private {
  export function createIndicator(
    panel: ICommentPanel,
    nbTracker: INotebookTracker
  ): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'jc-Indicator';

    indicator.onclick = () => {
      const cell = nbTracker.activeCell;
      if (cell == null) {
        return;
      }

      void InputDialog.getText({ title: 'Add Comment' }).then(value => {
        if (value.value == null) {
          return;
        }

        const model = panel.model;
        if (model == null) {
          return;
        }

        model.addComment({
          type: 'cell-selection',
          text: value.value,
          source: cell,
          identity: getIdentity(model.awareness)
        });

        panel.update();
      });
    };

    return indicator;
  }
}

const plugins: JupyterFrontEndPlugin<any>[] = [
  notebookCommentsPlugin,
  commentRegistryPlugin,
  jupyterCommentingPlugin
];
export default plugins;
