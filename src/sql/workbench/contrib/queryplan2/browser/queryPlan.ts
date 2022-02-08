/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/queryPlan2';
import type * as azdata from 'azdata';
import { IPanelView, IPanelTab } from 'sql/base/browser/ui/panel/panel';
import { localize } from 'vs/nls';
import { dispose } from 'vs/base/common/lifecycle';
import { IConfigurationRegistry, Extensions as ConfigExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { Registry } from 'vs/platform/registry/common/platform';
import { ActionBar } from 'sql/base/browser/ui/taskbar/actionbar';
import * as DOM from 'vs/base/browser/dom';
import * as azdataGraphModule from 'azdataGraph';
import { queryPlanNodeIconPaths } from 'sql/workbench/contrib/queryplan2/browser/constants';
import { isString } from 'vs/base/common/types';
import { PlanHeader } from 'sql/workbench/contrib/queryplan2/browser/planHeader';
import { GraphElementPropertiesView } from 'sql/workbench/contrib/queryplan2/browser/graphElementPropertiesView';
import { Action } from 'vs/base/common/actions';
import { Codicon } from 'vs/base/common/codicons';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { openNewQuery } from 'sql/workbench/contrib/query/browser/queryActions';
import { RunQueryOnConnectionMode } from 'sql/platform/connection/common/connectionManagement';
import { IColorTheme, ICssStyleCollector, IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { editorBackground, foreground, textLinkForeground } from 'vs/platform/theme/common/colorRegistry';
import { ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { ISashEvent, ISashLayoutProvider, Orientation, Sash } from 'vs/base/browser/ui/sash/sash';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IUntitledTextEditorService } from 'vs/workbench/services/untitled/common/untitledTextEditorService';
import { formatDocumentWithSelectedProvider, FormattingMode } from 'vs/editor/contrib/format/format';
import { Progress } from 'vs/platform/progress/common/progress';
import { CancellationToken } from 'vs/base/common/cancellation';

let azdataGraph = azdataGraphModule();

export class QueryPlan2Tab implements IPanelTab {
	public readonly title = localize('queryPlanTitle', "Query Plan");
	public readonly identifier = 'QueryPlan2Tab';
	public readonly view: QueryPlan2View;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this.view = instantiationService.createInstance(QueryPlan2View);
	}

	public dispose() {
		dispose(this.view);
	}

	public clear() {
		this.view.clear();
	}

}

export class QueryPlan2View implements IPanelView {
	private _qps?: QueryPlan2[] = [];
	private _graphs?: azdata.ExecutionPlanGraph[] = [];
	private _container = DOM.$('.qps-container');

	constructor(
		@IInstantiationService private instantiationService: IInstantiationService,
	) {
	}

	public render(container: HTMLElement): void {
		container.appendChild(this._container);
		this._container.style.overflow = 'scroll';
	}

	dispose() {
		this._container.remove();
		delete this._qps;
		delete this._graphs;
	}

	public layout(dimension: DOM.Dimension): void {
		this._container.style.width = dimension.width + 'px';
		this._container.style.height = dimension.height + 'px';
	}

	public clear() {
		this._qps = [];
		this._graphs = [];
		DOM.clearNode(this._container);
	}

	public addGraphs(newGraphs: azdata.ExecutionPlanGraph[] | undefined) {
		if (newGraphs) {
			newGraphs.forEach(g => {
				const qp2 = this.instantiationService.createInstance(QueryPlan2, this._container, this._qps.length + 1);
				qp2.graph = g;
				this._qps.push(qp2);
				this._graphs.push(g);
				this.updateRelativeCosts();
			});
		}
	}

	private updateRelativeCosts() {
		const sum = this._graphs.reduce((prevCost: number, cg) => {
			return prevCost += cg.root.subTreeCost + cg.root.cost;
		}, 0);

		if (sum > 0) {
			this._qps.forEach(qp => {
				qp.planHeader.relativeCost = ((qp.graph.root.subTreeCost + qp.graph.root.cost) / sum) * 100;
			});
		}
	}
}

export class QueryPlan2 implements ISashLayoutProvider {
	private _graph?: azdata.ExecutionPlanGraph;

	private _container: HTMLElement;

	private _actionBarContainer: HTMLElement;
	private _actionBar: ActionBar;

	public planHeader: PlanHeader;
	private _planContainer: HTMLElement;
	private _planHeaderContainer: HTMLElement;

	public propertiesView: GraphElementPropertiesView;
	private _propContainer: HTMLElement;

	private _azdataGraphDiagram: any;

	constructor(
		parent: HTMLElement,
		private _graphIndex: number,
		@IInstantiationService public readonly _instantiationService: IInstantiationService,
		@IThemeService private readonly _themeService: IThemeService,
		@IContextViewService public readonly contextViewService: IContextViewService,
		@IUntitledTextEditorService private readonly _untitledEditorService: IUntitledTextEditorService,
		@IEditorService private readonly editorService: IEditorService
	) {
		// parent container for query plan.
		this._container = DOM.$('.query-plan');
		parent.appendChild(this._container);
		const sashContainer = DOM.$('.query-plan-sash');
		parent.appendChild(sashContainer);

		const sash = new Sash(sashContainer, this, { orientation: Orientation.HORIZONTAL });
		let originalHeight = this._container.offsetHeight;
		let originalTableHeight = 0;
		let change = 0;
		sash.onDidStart((e: ISashEvent) => {
			originalHeight = this._container.offsetHeight;
			originalTableHeight = this.propertiesView.tableHeight;
		});

		/**
		 * Using onDidChange for the smooth resizing of the graph diagram
		 */
		sash.onDidChange((evt: ISashEvent) => {
			change = evt.startY - evt.currentY;
			const newHeight = originalHeight - change;
			if (newHeight < 200) {
				return;
			}
			this._container.style.height = `${newHeight}px`;
		});

		/**
		 * Resizing properties window table only once at the end as it is a heavy operation and worsens the smooth resizing experience
		 */
		sash.onDidEnd(() => {
			this.propertiesView.tableHeight = originalTableHeight - change;
		});

		this._planContainer = DOM.$('.plan');
		this._container.appendChild(this._planContainer);

		// container that holds plan header info
		this._planHeaderContainer = DOM.$('.header');
		this._planContainer.appendChild(this._planHeaderContainer);
		this.planHeader = this._instantiationService.createInstance(PlanHeader, this._planHeaderContainer, {
			planIndex: this._graphIndex,
		});

		// container properties
		this._propContainer = DOM.$('.properties');
		this._container.appendChild(this._propContainer);
		this.propertiesView = new GraphElementPropertiesView(this._propContainer, this._themeService);

		// container that holds actionbar icons
		this._actionBarContainer = DOM.$('.action-bar-container');
		this._container.appendChild(this._actionBarContainer);
		this._actionBar = new ActionBar(this._actionBarContainer, {
			orientation: ActionsOrientation.VERTICAL, context: this
		});


		const actions = [
			new SaveXml(),
			new OpenGraphFile(),
			new OpenQueryAction(),
			new SearchNodeAction(),
			new ZoomInAction(),
			new ZoomOutAction(),
			new ZoomToFitAction(),
			new CustomZoomAction(),
			new PropertiesAction(),
		];
		this._actionBar.pushAction(actions, { icon: true, label: false });


	}

	getHorizontalSashTop(sash: Sash): number {
		return 0;
	}
	getHorizontalSashLeft?(sash: Sash): number {
		return 0;
	}
	getHorizontalSashWidth?(sash: Sash): number {
		return this._container.clientWidth;
	}

	private populate(node: azdata.ExecutionPlanNode, diagramNode: any): any {
		diagramNode.label = node.name;

		if (node.properties && node.properties.length > 0) {
			diagramNode.metrics = this.populateProperties(node.properties);
		}

		if (node.type) {
			diagramNode.icon = node.type;
		}

		if (node.children) {
			diagramNode.children = [];
			for (let i = 0; i < node.children.length; ++i) {
				diagramNode.children.push(this.populate(node.children[i], new Object()));
			}
		}

		if (node.edges) {
			diagramNode.edges = [];
			for (let i = 0; i < node.edges.length; i++) {
				diagramNode.edges.push(this.populateEdges(node.edges[i], new Object()));
			}
		}
		return diagramNode;
	}

	private populateEdges(edge: azdata.ExecutionPlanEdge, diagramEdge: any) {
		diagramEdge.label = '';
		diagramEdge.metrics = this.populateProperties(edge.properties);
		diagramEdge.weight = Math.max(0.5, Math.min(0.5 + 0.75 * Math.log10(edge.rowCount), 6));
		return diagramEdge;
	}

	private populateProperties(props: azdata.ExecutionPlanGraphElementProperty[]) {
		return props.filter(e => isString(e.value))
			.map(e => {
				return {
					name: e.name,
					value: e.value.toString().substring(0, 75)
				};
			});
	}

	private createPlanDiagram(container: HTMLElement): void {
		let diagramRoot: any = new Object();
		let graphRoot: azdata.ExecutionPlanNode = this._graph.root;
		this.populate(graphRoot, diagramRoot);
		this._azdataGraphDiagram = new azdataGraph.azdataQueryPlan(container, diagramRoot, queryPlanNodeIconPaths);

		registerThemingParticipant((theme: IColorTheme, collector: ICssStyleCollector) => {
			const iconBackground = theme.getColor(editorBackground);
			if (iconBackground) {
				this._azdataGraphDiagram.setIconBackgroundColor(iconBackground);
			}

			const iconLabelColor = theme.getColor(foreground);
			if (iconLabelColor) {
				this._azdataGraphDiagram.setTextFontColor(iconLabelColor);
			}
		});
	}


	public set graph(graph: azdata.ExecutionPlanGraph | undefined) {
		this._graph = graph;
		if (this._graph) {
			this.planHeader.graphIndex = this._graphIndex;
			this.planHeader.query = graph.query;
			if (graph.recommendations) {
				this.planHeader.recommendations = graph.recommendations;
			}
			let diagramContainer = DOM.$('.diagram');
			this.createPlanDiagram(diagramContainer);
			this._planContainer.appendChild(diagramContainer);

			this.propertiesView.graphElement = this._graph.root;
		}
	}

	public get graph(): azdata.ExecutionPlanGraph | undefined {
		return this._graph;
	}

	public openQuery() {
		return this._instantiationService.invokeFunction(openNewQuery, undefined, this.graph.query, RunQueryOnConnectionMode.none).then();
	}

	public async openGraphFile() {
		const input = this._untitledEditorService.create({ mode: this.graph.graphFile.graphFileType, initialValue: this.graph.graphFile.graphFileContent });
		await input.resolve();
		await this._instantiationService.invokeFunction(formatDocumentWithSelectedProvider, input.textEditorModel, FormattingMode.Explicit, Progress.None, CancellationToken.None);
		input.setDirty(false);
		this.editorService.openEditor(input);
	}
}

class OpenQueryAction extends Action {
	public static ID = 'qp.OpenQueryAction';
	public static LABEL = localize('openQueryAction', "Open Query");

	constructor() {
		super(OpenQueryAction.ID, OpenQueryAction.LABEL, Codicon.dash.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
		context.openQuery();
	}
}

class PropertiesAction extends Action {
	public static ID = 'qp.propertiesAction';
	public static LABEL = localize('queryPlanPropertiesActionLabel', "Properties");

	constructor() {
		super(PropertiesAction.ID, PropertiesAction.LABEL, Codicon.book.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
		context.propertiesView.toggleVisibility();
	}
}

class ZoomInAction extends Action {
	public static ID = 'qp.ZoomInAction';
	public static LABEL = localize('queryPlanZoomInActionLabel', "Zoom In");

	constructor() {
		super(ZoomInAction.ID, ZoomInAction.LABEL, Codicon.zoomIn.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
	}
}

class ZoomOutAction extends Action {
	public static ID = 'qp.ZoomOutAction';
	public static LABEL = localize('queryPlanZoomOutActionLabel', "Zoom Out");

	constructor() {
		super(ZoomOutAction.ID, ZoomOutAction.LABEL, Codicon.zoomOut.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
	}
}

class ZoomToFitAction extends Action {
	public static ID = 'qp.FitGraph';
	public static LABEL = localize('queryPlanFitGraphLabel', "Zoom to fit");

	constructor() {
		super(ZoomToFitAction.ID, ZoomToFitAction.LABEL, Codicon.debugStop.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
	}
}

class SaveXml extends Action {
	public static ID = 'qp.saveXML';
	public static LABEL = localize('queryPlanSavePlanXML', "Save XML");

	constructor() {
		super(SaveXml.ID, SaveXml.LABEL, Codicon.save.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
	}
}


class CustomZoomAction extends Action {
	public static ID = 'qp.customZoom';
	public static LABEL = localize('queryPlanCustomZoom', "Custom Zoom");

	constructor() {
		super(CustomZoomAction.ID, CustomZoomAction.LABEL, Codicon.searchStop.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
	}
}

class SearchNodeAction extends Action {
	public static ID = 'qp.searchNode';
	public static LABEL = localize('queryPlanSearchNodeAction', "SearchNode");

	constructor() {
		super(SearchNodeAction.ID, SearchNodeAction.LABEL, Codicon.search.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
	}
}

class OpenGraphFile extends Action {
	public static ID = 'qp.openGraphFile';
	public static Label = localize('queryPlanOpenGraphFile', "Open Graph File");

	constructor() {
		super(OpenGraphFile.ID, OpenGraphFile.Label, Codicon.output.classNames);
	}

	public override async run(context: QueryPlan2): Promise<void> {
		await context.openGraphFile();
	}
}

registerThemingParticipant((theme: IColorTheme, collector: ICssStyleCollector) => {
	const menuBackgroundColor = theme.getColor(editorBackground);
	if (menuBackgroundColor) {
		collector.addRule(`
		.qps-container .query-plan .plan .plan-action-container .child {
			background-color: ${menuBackgroundColor};
		}
		`);
	}
	const recommendationsColor = theme.getColor(textLinkForeground);
	if (recommendationsColor) {
		collector.addRule(`
		.qps-container .query-plan .plan .header .recommendations {
			color: ${recommendationsColor};
		}
		`);
	}
});


/**
 * Registering a feature flag for query plan.
 * TODO: This should be removed before taking the feature to public preview.
 */
const QUERYPLAN2_CONFIG_ID = 'queryPlan2';
Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration).registerConfiguration({
	id: QUERYPLAN2_CONFIG_ID,
	title: localize('queryPlan2.configTitle', "Query Plan"),
	type: 'object',
	properties: {
		'queryPlan2.enableFeature': {
			'type': 'boolean',
			'default': false,
			'description': localize('queryPlan2.featureEnabledDescription', "Controls whether the new query plan feature is enabled. Default value is false.")
		}
	}
});

