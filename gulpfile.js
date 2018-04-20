'use strict';

var gulp = require('gulp');
var tslint = require('gulp-tslint');

var sources = ['./src/**/*.ts'];

function compileTypescript() {
  require('child_process').exec('tsc -p ' + process.cwd(), function (err, stdout, stderr) {
    err && console.error(err);
    console.log(stdout.toString());
    console.error(stderr.toString());
  });
}

function compileTypescriptIgnoreError() {
  require('child_process').exec('tsc -p ' + process.cwd() + ' --noEmitOnError', function (err, stdout, stderr) {
    err && console.error(err);
    console.log(stdout.toString());
    console.error(stderr.toString());
  });
}

function watch() {
  gulp.watch(sources, ['buildIgnoreError']);
}

function clean(done) {
  var del = require('del');
  del(['./dist', './node_modules'], done);
}

function doLint() {
  if (process.env.npm_lifecycle_event === 'test') return;
  return gulp.src('src/**/*.ts')
    .pipe(tslint({
      formatter: 'stylish'
    }))
    .pipe(tslint.report({
      summarizeFailureOutput: true
    }));
}

gulp.task('build',['tslint'], compileTypescript);
gulp.task('buildIgnoreError', compileTypescriptIgnoreError);
gulp.task('watch', watch);
gulp.task('clean', clean);
gulp.task('tslint', doLint);
