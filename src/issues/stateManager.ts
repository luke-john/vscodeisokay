/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as LRUCache from 'lru-cache';
import * as vscode from 'vscode';
import { IssueModel } from '../github/issueModel';
import { IAccount } from '../github/interface';
import { PullRequestManager, PRManagerState, NO_MILESTONE } from '../github/pullRequestManager';
import { MilestoneModel } from '../github/milestoneModel';
import { API as GitAPI, GitExtension } from '../typings/git';
import { ISSUES_CONFIGURATION } from './util';

// TODO: make exclude from date words configurable
const excludeFromDate: string[] = ['Recovery'];
const CUSTOM_QUERY_CONFIGURATION = 'customQuery';

export class StateManager {
	public readonly resolvedIssues: LRUCache<string, IssueModel> = new LRUCache(50); // 50 seems big enough
	public readonly userMap: Map<string, IAccount> = new Map();
	private _lastHead: string | undefined;
	private _milestones: Promise<MilestoneModel[]> = Promise.resolve([]);
	private _issues: Promise<IssueModel[]> = Promise.resolve([]);
	private _onRefreshCacheNeeded: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onRefreshCacheNeeded: vscode.Event<void> = this._onRefreshCacheNeeded.event;
	private _onDidChangeIssueData: vscode.EventEmitter<void> = new vscode.EventEmitter();
	public onDidChangeIssueData: vscode.Event<void> = this._onDidChangeIssueData.event;
	private _query: string | undefined;

	get issueData(): { byMilestone?: Promise<MilestoneModel[]>, byIssue?: Promise<IssueModel[]> } {
		return this._query ? { byIssue: this._issues } : { byMilestone: this._milestones };
	}

	constructor(private manager: PullRequestManager) { }

	async initialize(context: vscode.ExtensionContext) {
		return new Promise(resolve => {
			if (this.manager.state === PRManagerState.RepositoriesLoaded) {
				this.doInitialize(context);
				resolve();
			} else {
				const disposable = this.manager.onDidChangeState(() => {
					if (this.manager.state === PRManagerState.RepositoriesLoaded) {
						this.doInitialize(context);
						disposable.dispose();
						resolve();
					}
				});
				context.subscriptions.push(disposable);
			}
		});
	}

	private registerRepositoryChangeEvent(context: vscode.ExtensionContext) {
		const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports;
		const git: GitAPI = gitExtension.getAPI(1);
		git.repositories.forEach(repository => {
			context.subscriptions.push(repository.state.onDidChange(() => {
				if ((repository.state.HEAD ? repository.state.HEAD.commit : undefined) !== this._lastHead) {
					this._lastHead = (repository.state.HEAD ? repository.state.HEAD.commit : undefined);
					this.setIssueData();
				}
			}));
		});
	}

	refreshCacheNeeded() {
		this._onRefreshCacheNeeded.fire();
	}

	private async doInitialize(context: vscode.ExtensionContext) {
		this._query = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(CUSTOM_QUERY_CONFIGURATION, undefined);
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(change => {
			if (change.affectsConfiguration(`${ISSUES_CONFIGURATION}.${CUSTOM_QUERY_CONFIGURATION}`)) {
				this._query = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get(CUSTOM_QUERY_CONFIGURATION, undefined);
				this._onRefreshCacheNeeded.fire();
			}
		}));
		this._lastHead = this.manager.repository.state.HEAD ? this.manager.repository.state.HEAD.commit : undefined;
		await this.setUsers();
		await this.setIssueData();
		this.registerRepositoryChangeEvent(context);
		context.subscriptions.push(this.onRefreshCacheNeeded(() => {
			this.setIssueData();
		}));
	}

	async setUsers() {
		const assignableUsers = await this.manager.getAssignableUsers();
		for (const remote in assignableUsers) {
			assignableUsers[remote].forEach(account => {
				this.userMap.set(account.login, account);
			});
		}
	}

	private setIssueData() {
		if (this._query) {
			this._milestones = Promise.resolve([]);
			this._issues = this.setIssues();
		} else {
			this._issues = Promise.resolve([]);
			this._milestones = this.setMilestones();
		}
	}

	private setIssues(): Promise<IssueModel[]> {
		return new Promise(async (resolve) => {
			const issues = await this.manager.getIssues({ fetchNextPage: false }, this._query);
			this._onDidChangeIssueData.fire();
			resolve(issues.items.map(item => item));
		});
	}

	private setMilestones(): Promise<MilestoneModel[]> {
		return new Promise(async (resolve) => {
			const now = new Date();
			const skipMilestones: string[] = vscode.workspace.getConfiguration(ISSUES_CONFIGURATION).get('ignoreMilestones', []);
			const milestones = await this.manager.getMilestones({ fetchNextPage: false }, skipMilestones.indexOf(NO_MILESTONE) < 0);
			let mostRecentPastTitleTime: Date | undefined = undefined;
			const milestoneDateMap: Map<string, Date> = new Map();
			const milestonesToUse: MilestoneModel[] = [];

			// The number of milestones is expected to be very low, so two passes through is negligible
			for (let i = 0; i < milestones.items.length; i++) {
				const item = milestones.items[i];
				const milestone = milestones.items[i].milestone;
				if ((item.issues && item.issues.length <= 0) || (skipMilestones.indexOf(milestone.title) >= 0)) {
					continue;
				}
				milestonesToUse.push(item);
				let milestoneDate = milestone.dueOn ? new Date(milestone.dueOn) : undefined;
				if (!milestoneDate) {
					milestoneDate = new Date(this.removeDateExcludeStrings(milestone.title));
					if (isNaN(milestoneDate.getTime())) {
						milestoneDate = new Date(milestone.createdAt!);
					}
				}
				if ((milestoneDate < now) && ((mostRecentPastTitleTime === undefined) || (milestoneDate > mostRecentPastTitleTime))) {
					mostRecentPastTitleTime = milestoneDate;
				}
				milestoneDateMap.set(milestone.id ? milestone.id : milestone.title, milestoneDate);
			}

			milestonesToUse.sort((a: MilestoneModel, b: MilestoneModel): number => {
				const dateA = milestoneDateMap.get(a.milestone.id ? a.milestone.id : a.milestone.title)!;
				const dateB = milestoneDateMap.get(b.milestone.id ? b.milestone.id : b.milestone.title)!;
				if (mostRecentPastTitleTime && (dateA >= mostRecentPastTitleTime) && (dateB >= mostRecentPastTitleTime)) {
					return dateA <= dateB ? -1 : 1;
				} else {
					return dateA >= dateB ? -1 : 1;
				}
			});
			this._onDidChangeIssueData.fire();
			resolve(milestonesToUse);
		});
	}

	private removeDateExcludeStrings(possibleDate: string): string {
		excludeFromDate.forEach(exclude => possibleDate = possibleDate.replace(exclude, ''));
		return possibleDate;
	}
}