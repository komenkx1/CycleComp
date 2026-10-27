import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { SFIcon, navigationSymbolName } from '../src/components/SFIcon';

jest.mock('react-native', () => ({ Platform: { OS: 'android' }, requireNativeComponent: jest.fn() }));
jest.mock('@react-native-vector-icons/material-design-icons/static', () => {
  const ReactModule = require('react');
  return { MaterialDesignIcons: (props: object) => ReactModule.createElement('MaterialIcon', props) };
});

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(entryPath) : entry.name.endsWith('.tsx') ? [entryPath] : [];
  });
}

function usedIconNames(): Set<string> {
  const iconNames = new Set<string>();
  const iconComponents = new Set(['SFIcon', 'NavigationButton', 'DashboardButton', 'RouteDirectionButton', 'ImportButton']);

  function collectExpression(expression: ts.Expression, fileName: string): void {
    if (ts.isStringLiteral(expression)) iconNames.add(expression.text);
    else if (ts.isConditionalExpression(expression)) {
      collectExpression(expression.whenTrue, fileName);
      collectExpression(expression.whenFalse, fileName);
    } else if (ts.isIdentifier(expression) && ['icon', 'undefined'].includes(expression.text)) {
      return;
    } else if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'navigationSymbolName') {
      return;
    } else {
      throw new Error(`Unreviewed icon expression in ${fileName}: ${expression.getText()}`);
    }
  }

  for (const fileName of sourceFiles(path.join(process.cwd(), 'src'))) {
    const source = ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node): void {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const componentName = node.tagName.getText(source);
        if (iconComponents.has(componentName)) {
          for (const attribute of node.attributes.properties) {
            if (!ts.isJsxAttribute(attribute) || attribute.name.getText(source) !== (componentName === 'SFIcon' ? 'name' : 'icon')) continue;
            if (attribute.initializer && ts.isStringLiteral(attribute.initializer)) iconNames.add(attribute.initializer.text);
            else if (attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
              collectExpression(attribute.initializer.expression, fileName);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const maneuver of ['slight_right', 'right', 'sharp_right', 'slight_left', 'left', 'sharp_left', 'u_turn', 'finish', 'straight']) {
    iconNames.add(navigationSymbolName(maneuver));
  }
  return iconNames;
}

function renderedIconName(symbolName: string): string {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  act(() => { renderer = ReactTestRenderer.create(<SFIcon name={symbolName} />); });
  const iconName = renderer!.root.findByType('MaterialIcon' as never).props.name as string;
  act(() => { renderer.unmount(); });
  return iconName;
}

test('every SF symbol used by the app has an Android icon', () => {
  const missingIconNames = [...usedIconNames()].filter(name => renderedIconName(name) === 'help-circle-outline');
  expect(missingIconNames).toEqual([]);
});

test('maps recenter and forward-route icons to their Android equivalents', () => {
  expect(renderedIconName('location.fill')).toBe('navigation-variant');
  expect(renderedIconName('arrow.up.forward')).toBe('arrow-top-right');
});
