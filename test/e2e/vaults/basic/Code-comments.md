# Comments on code

A block with a comment on one line, one on two lines, and one on the whole block:

```js
let x = 1
let y = 2
let x = 1
console.log(x + y)
```
{>>Why not const?<<}{author=Tester time=1795282324 quote="let x = 1" line=3} {>>These two belong together.<<}{author=Tester time=1795282324 quote="let y" line=2 lines=2} {>>Needs a test.<<}{author=Tester time=1795282324}

A block whose quoted code has changed:

```python
def add(a, b):
    return a - b
```
{>>Is this right?<<}{author=Tester time=1795282324 quote="return a + b" line=2}

A comment that lost its block (a blank line in between):

```sh
echo hello
```

{>>Quote it?<<}{author=Tester time=1795282324 quote="echo hello" line=1}

An uncommented block to comment on:

```ts
function greet(name: string) {
	return `Hello, ${name}`;
}
```

The end.
