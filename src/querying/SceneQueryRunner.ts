import { cloneDeep } from 'lodash';
import { mergeMap, MonoTypeOperatorFunction, Unsubscribable, map, of, ReplaySubject } from 'rxjs';

import {
  CoreApp,
  DataQuery,
  DataQueryRequest,
  DataSourceRef,
  DataTransformerConfig,
  PanelData,
  preProcessPanelData,
  rangeUtil,
  ScopedVar,
  TimeRange,
  transformDataFrame,
} from '@grafana/data';
import { getRunRequest } from '@grafana/runtime';

import { SceneObjectBase } from '../core/SceneObjectBase';
import { sceneGraph } from '../core/sceneGraph';
import { CustomTransformOperator, SceneObject, SceneObjectStatePlain } from '../core/types';
import { getDataSource } from '../utils/getDataSource';
import { VariableDependencyConfig } from '../variables/VariableDependencyConfig';
import { SceneVariable } from '../variables/types';
import { writeSceneLog } from '../utils/writeSceneLog';
import { VariableValueRecorder } from '../variables/VariableValueRecorder';
import { ReprocessTransformationsEvent, SceneQueryRunnerDataTransformer } from './transformations';

let counter = 100;

export function getNextRequestId() {
  return 'QS' + counter++;
}

export interface QueryRunnerState extends SceneObjectStatePlain {
  data?: PanelData;
  dataPreTransforms?: PanelData;
  queries: DataQueryExtended[];
  datasource?: DataSourceRef;
  minInterval?: string;
  maxDataPoints?: number;
  transformer?: SceneQueryRunnerDataTransformer;
  // Non persisted state
  maxDataPointsFromWidth?: boolean;
  isWaitingForVariables?: boolean;
}

export interface DataQueryExtended extends DataQuery {
  [key: string]: any;
}

export class SceneQueryRunner extends SceneObjectBase<QueryRunnerState> {
  private _querySub?: Unsubscribable;
  private _containerWidth?: number;
  private _variableValueRecorder = new VariableValueRecorder();
  private _rawDataSubject = new ReplaySubject<PanelData>(1);
  /**
   * Also stored in state, this is just to store it while rxjs pipeline is running and to then have a single state change
   * when we store this and the transformed data.
   **/
  private _dataPreTransforms?: PanelData;

  protected _variableDependency: VariableDependencyConfig<QueryRunnerState> = new VariableDependencyConfig(this, {
    statePaths: ['queries', 'datasource'],
    onVariableUpdatesCompleted: (variables, dependencyChanged) =>
      this.onVariableUpdatesCompleted(variables, dependencyChanged),
  });

  public activate() {
    super.activate();

    const timeRange = sceneGraph.getTimeRange(this);

    this._subs.add(
      timeRange.subscribeToState({
        next: (timeRange) => {
          this.runWithTimeRange(timeRange.value);
        },
      })
    );

    // Pipe raw data through the transformations and store in state
    this._subs.add(
      this._rawDataSubject.pipe(mergeMap(this.transformData)).subscribe((data) => {
        this.setState({ data, dataPreTransforms: this._dataPreTransforms });
      })
    );

    if (this.state.transformer) {
      this.state.transformer.activate();

      // Subscribe to transformer wanting to re-process transformations
      this._subs.add(
        this.state.transformer.subscribeToEvent(ReprocessTransformationsEvent, () => {
          this._rawDataSubject.next(this.state.dataPreTransforms!);
        })
      );
    }

    if (this.shouldRunQueriesOnActivate()) {
      this.runQueries();
    }
  }

  /**
   * Handles some tricky cases where we need to run queries even when they have not changed in case
   * the query execution on activate was stopped due to VariableSet still not having processed all variables.
   */
  private onVariableUpdatesCompleted(_variablesThatHaveChanged: Set<SceneVariable>, dependencyChanged: boolean) {
    if (this.state.isWaitingForVariables && this.shouldRunQueriesOnActivate()) {
      this.runQueries();
      return;
    }

    if (dependencyChanged) {
      this.runQueries();
    }
  }

  private shouldRunQueriesOnActivate() {
    // If no maxDataPoints specified we might need to wait for container width to be set from the outside
    if (!this.state.maxDataPoints && this.state.maxDataPointsFromWidth && !this._containerWidth) {
      return false;
    }

    if (this._variableValueRecorder.hasDependenciesChanged(this)) {
      writeSceneLog(
        'SceneQueryRunner',
        'Variable dependency changed while inactive, shouldRunQueriesOnActivate returns true'
      );
      return true;
    }

    // If we already have data, no need
    // TODO validate that time range is similar and if not we should run queries again
    if (this.state.data) {
      return false;
    }

    return true;
  }

  public deactivate(): void {
    super.deactivate();

    if (this._querySub) {
      this._querySub.unsubscribe();
      this._querySub = undefined;
    }

    if (this.state.transformer) {
      this.state.transformer.deactivate();
    }

    this._variableValueRecorder.recordCurrentDependencyValuesForSceneObject(this);
  }

  public setContainerWidth(width: number) {
    // If we don't have a width we should run queries
    if (!this._containerWidth && width > 0) {
      this._containerWidth = width;

      // If we don't have maxDataPoints specifically set and maxDataPointsFromWidth is true
      if (this.state.maxDataPointsFromWidth && !this.state.maxDataPoints) {
        // As this is called from render path we need to wait for next tick before running queries
        setTimeout(() => {
          if (this.isActive && !this._querySub) {
            this.runQueries();
          }
        }, 0);
      }
    } else {
      // if the updated container width is bigger than 0 let's remember the width until next query issue
      if (width > 0) {
        this._containerWidth = width;
      }
    }
  }

  public runQueries() {
    const timeRange = sceneGraph.getTimeRange(this);
    this.runWithTimeRange(timeRange.state.value);
  }

  private getMaxDataPoints() {
    return this.state.maxDataPoints ?? this._containerWidth ?? 500;
  }

  private async runWithTimeRange(timeRange: TimeRange) {
    // Skip executing queries if variable dependency is in loading state
    if (sceneGraph.hasVariableDependencyInLoadingState(this)) {
      writeSceneLog('SceneQueryRunner', 'Variable dependency is in loading state, skipping query execution');
      this.setState({ isWaitingForVariables: true });
      return;
    }

    // If we where waiting for variables clear that flag
    if (this.state.isWaitingForVariables) {
      this.setState({ isWaitingForVariables: false });
    }

    const { datasource, minInterval, queries } = this.state;
    const sceneObjectScopedVar: Record<string, ScopedVar<SceneQueryRunner>> = {
      __sceneObject: { text: '__sceneObject', value: this },
    };

    const request: DataQueryRequest = {
      app: CoreApp.Dashboard,
      requestId: getNextRequestId(),
      timezone: 'browser',
      panelId: 1,
      dashboardId: 1,
      range: timeRange,
      interval: '1s',
      intervalMs: 1000,
      targets: cloneDeep(queries),
      maxDataPoints: this.getMaxDataPoints(),
      scopedVars: sceneObjectScopedVar,
      startTime: Date.now(),
    };

    try {
      const ds = await getDataSource(datasource, request.scopedVars);

      // Attach the data source name to each query
      request.targets = request.targets.map((query) => {
        if (!query.datasource) {
          query.datasource = ds.getRef();
        }
        return query;
      });

      // TODO interpolate minInterval
      const lowerIntervalLimit = minInterval ? minInterval : ds.interval;
      const norm = rangeUtil.calculateInterval(timeRange, request.maxDataPoints!, lowerIntervalLimit);

      // make shallow copy of scoped vars,
      // and add built in variables interval and interval_ms
      request.scopedVars = Object.assign({}, request.scopedVars, {
        __interval: { text: norm.interval, value: norm.interval },
        __interval_ms: { text: norm.intervalMs.toString(), value: norm.intervalMs },
      });

      request.interval = norm.interval;
      request.intervalMs = norm.intervalMs;

      const runRequest = getRunRequest();

      writeSceneLog('SceneQueryRunner', 'Starting runRequest', this.state.key);

      this._querySub = runRequest(ds, request).subscribe((data) => this._rawDataSubject.next(data));
    } catch (err) {
      console.error('PanelQueryRunner Error', err);
    }
  }

  transformData = (data: PanelData) => {
    const { transformer } = this.state;

    this._dataPreTransforms = data;

    const preProcessedData = preProcessPanelData(data, this.state.data);

    if (!transformer) {
      return of(preProcessedData);
    }

    return transformer.transform(preProcessedData);
  };
}

export function getTransformationsStream(
  sceneObject: SceneObject,
  transformations?: Array<DataTransformerConfig | CustomTransformOperator>,
  lastResult?: PanelData
): MonoTypeOperatorFunction<PanelData> {
  return (inputStream) => {
    return inputStream.pipe(
      mergeMap((data) => {
        const preProcessedData = preProcessPanelData(data, lastResult);

        if (!transformations || transformations.length === 0) {
          return of(preProcessedData);
        }

        const ctx = {
          interpolate: (value: string) => {
            return sceneGraph.interpolate(sceneObject, value, preProcessedData?.request?.scopedVars);
          },
        };

        return transformDataFrame(transformations, data.series, ctx).pipe(map((series) => ({ ...data, series })));
      })
    );
  };
}
