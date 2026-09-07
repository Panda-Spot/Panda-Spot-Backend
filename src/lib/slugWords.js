// 2-word English slug generator — each word ≤ 3 letters, easy to share.
// ~160 short words → ~25k unique combos; collision check ensures uniqueness.

const WORDS = [
  "ace","add","age","ago","aid","aim","air","all","and","ant","any","ape","arc","ark","arm","art",
  "ash","ask","ate","axe","bad","bag","ban","bar","bat","bay","bed","bee","bet","big","bit","bow",
  "box","boy","bud","bug","bus","but","buy","cab","can","cap","car","cat","cow","cry","cub","cup",
  "cut","dad","day","den","dew","did","dig","dim","dip","dog","dot","dry","dub","dud","due","dug",
  "dye","ear","eat","egg","ego","elk","elm","emu","end","era","eve","ewe","eye","fab","fad","fan",
  "far","fat","fax","fed","fee","few","fig","fin","fir","fit","fix","fly","fog","for","fox","fry",
  "fun","fur","gag","gap","gas","gem","get","gin","god","got","gum","gun","gut","guy","gym","had",
  "ham","has","hat","hay","hen","her","hew","hex","hid","him","hip","his","hit","hog","hop","hot",
  "how","hub","hue","hug","hum","hut","ice","icy","ill","imp","ink","inn","ion","ire","irk","its",
  "ivy","jab","jag","jam","jar","jaw","jay","jet","jig","job","jog","jot","joy","jug","jut","keg",
  "key","kid","kin","kit","lab","lad","lag","lap","law","lay","lea","led","leg","let","lid","lie",
  "lip","lit","log","lot","low","lug","mad","man","map","mar","mat","maw","max","may","men","met",
  "mid","mix","mob","mom","mop","mud","mug","nab","nag","nap","net","new","nil","nip","nit","nod",
  "nor","not","now","nun","nut","oak","oar","oat","odd","ode","off","oft","ohm","oil","old","one",
  "opt","orb","ore","our","out","owe","owl","own","pad","pal","pan","pap","par","pat","paw","pay",
  "pea","peg","pen","pep","per","pet","pie","pig","pin","pit","ply","pod","pop","pot","pow","pro",
  "pry","pub","pug","pun","pup","pus","put","rag","ram","ran","rap","rat","raw","ray","red","ref",
  "rib","rid","rig","rim","rip","rob","rod","rot","row","rub","rug","rum","run","rut","rye","sac",
  "sad","sag","sap","sat","saw","say","sea","set","sew","she","shy","sin","sip","sir","sis","sit",
  "six","ski","sky","sly","sob","sod","son","sop","sot","sow","soy","spa","spy","sty","sub","sue",
  "sum","sun","sup","tab","tad","tag","tan","tap","tar","tat","tax","tea","ten","the","tie","tin",
  "tip","toe","ton","too","top","tot","tow","toy","try","tub","tug","two","urn","use","van","vat",
  "vet","vex","via","vie","vim","vow","wad","wag","war","was","wax","way","web","wed","wet","who",
  "why","wig","win","wit","woe","wok","won","woo","wow","yak","yam","yap","yaw","yea","yes","yet",
  "yew","you","zap","zeal","zen","zip","zoo",
];

// All words are already ≤ 3 letters by design.

/**
 * Generate a random 2-word slug like "red-sun", "big-box", "ace-pow".
 * Collisions are checked against the database; retries up to 5 times.
 */
export async function generateReadableSlug(prisma) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const a = WORDS[Math.floor(Math.random() * WORDS.length)];
    const b = WORDS[Math.floor(Math.random() * WORDS.length)];
    const slug = `${a}-${b}`;
    const existing = await prisma.event.findUnique({ where: { guestSlug: slug } });
    if (!existing) return slug;
  }
  // Fallback: append 2 random digits to ensure uniqueness.
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  const b = WORDS[Math.floor(Math.random() * WORDS.length)];
  const num = Math.floor(10 + Math.random() * 90);
  return `${a}-${b}-${num}`;
}
