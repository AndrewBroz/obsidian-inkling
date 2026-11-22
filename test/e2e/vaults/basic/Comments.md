# Comment highlighting test

New format: this is {==highlighted text==}{>>a comment on it<<}{author=Tester time=1795282324} in a sentence.

Legacy format: this is {=={"author":"Tester","time":1795282324}@@other highlighted text==}{>>{"author":"Tester","time":1795282324}@@a legacy comment<<} in a sentence.

Bare: this is {==plain highlight==}{>>bare comment<<} here.

Suggestions: an {++addition++}{author=Tester time=1795282324}, a {--deletion--}{author=Tester time=1795282324}, and {~~old~>new~~}{author=Tester time=1795282324}.
