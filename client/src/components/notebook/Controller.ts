// Copyright © 2023, SAS Institute Inc., Cary, NC, USA. All Rights Reserved.
// Licensed under SAS Code Extension Terms, available at Code_Extension_Agreement.pdf

import * as vscode from "vscode";
import { getSession } from "../../connection";
import { Deferred, deferred } from "../utils";

export class NotebookController {
  readonly controllerId = "sas-notebook-controller-id";
  readonly notebookType = "sas-notebook";
  readonly label = "SAS Notebook";
  readonly supportedLanguages = ["sas", "sql", "python"];

  private readonly _controller: vscode.NotebookController;
  private _executionOrder = 0;
  private _interrupted: Deferred<void> | undefined;

  constructor() {
    this._controller = vscode.notebooks.createNotebookController(
      this.controllerId,
      this.notebookType,
      this.label
    );

    this._controller.supportedLanguages = this.supportedLanguages;
    this._controller.supportsExecutionOrder = true;
    this._controller.executeHandler = this._execute.bind(this);
    this._controller.interruptHandler = this._interrupt.bind(this);
  }

  dispose(): void {
    this._controller.dispose();
  }

  private async _execute(cells: vscode.NotebookCell[]): Promise<void> {
    this._interrupted = undefined;

    try {
      const session = getSession();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Connecting to SAS session...",
        },
        session.setup
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        err.response?.data ? JSON.stringify(err.response.data) : err.message
      );
      return;
    }

    for (const cell of cells) {
      await this._doExecution(cell);
    }
  }

  private async _doExecution(cell: vscode.NotebookCell): Promise<void> {
    if (this._interrupted) {
      return;
    }

    const execution = this._controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this._executionOrder;
    execution.start(Date.now()); // Keep track of elapsed time to execute cell.

    const session = getSession();
    let logs = [];
    try {
      const result = await session.run(getCode(cell.document), (logLines) => {
        logs = logs.concat(logLines);
      });

      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          ...(result.html5?.length
            ? [
                vscode.NotebookCellOutputItem.text(
                  result.html5,
                  "application/vnd.sas.ods.html5"
                ),
              ]
            : []),
          vscode.NotebookCellOutputItem.json(
            logs,
            "application/vnd.sas.compute.log.lines"
          ),
        ]),
      ]);
      execution.end(true, Date.now());
    } catch (error) {
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(error),
        ]),
      ]);
      execution.end(false, Date.now());
    }
    if (this._interrupted) {
      this._interrupted.resolve();
      this._interrupted = undefined;
    }
  }

  private _interrupt() {
    if (this._interrupted) {
      return;
    }
    this._interrupted = deferred();
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Cancelling job...",
      },
      () => this._interrupted.promise
    );
    const session = getSession();
    session.cancel?.();
  }
}

const getCode = (doc: vscode.TextDocument) => {
  const outputHtml = !!vscode.workspace
    .getConfiguration("SAS")
    .get("session.outputHtml");

  let code = doc.getText();
  if (doc.languageId === "sql") {
    code = wrapSQL(code);
  } else if (doc.languageId === "python") {
    code = wrapPython(code);
  }
  return outputHtml ? wrapHTML5(code) : code;
};

const wrapHTML5 = (code: string) => `ods html5;
${code}
;run;quit;ods html5 close;`;

const wrapSQL = (code: string) => `proc sql;
${code}
;quit;`;

const wrapPython = (code: string) => `proc python;
submit;
${code}
endsubmit;
run;`;