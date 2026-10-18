// Ingredient normalizer shared by the Larder (runtime) and the catalog build.
const STRIP_WORDS = ['fresh','baby','organic','local','large','medium','small','extra','jumbo','boneless','skinless','bone-in','skin-on','chopped','diced','sliced','minced','grated','shredded','crumbled','cubed','whole','ripe','raw','cooked','frozen','thawed','peeled','unpeeled','seedless','pitted','halved','quartered','trimmed','divided','container','packets','packet','pkg','package','can','canned','jar','bunch','bunches','head','heads','clove','cloves','sprig','sprigs','stalk','stalks','ear','ears','piece','pieces','slice','slices','of','and','or','with','your','own','pre-cut','precut','quick-cooking','quick','cooking','instant','plain','unsalted','salted','sweetened','unsweetened','full-fat','low-fat','lowfat','nonfat','reduced-fat','light','lite','regular','style','grass-fed','pasture-raised','free-range','hormone-free','antibiotic-free','natural','premium','select','use','half','only','ready','to','heat','ready-to-heat','inch','grain','thick-cut','thin-cut','mini'];
const STRIP_RE = new RegExp('\\b(' + STRIP_WORDS.map(w => w.replace(/-/g, '\\-')).join('|') + ')\\b', 'g');
const KEEP_S = new Set(['asparagus','couscous','hummus','grits','oats','molasses','brussels','swiss','haricots','pepperoncini','chickpeas']);
const ALIASES = {
  'parmesan cheese':'parmesan','shaved parmesan cheese':'parmesan','shaved parmesan':'parmesan','grated parmesan cheese':'parmesan','grated parmesan':'parmesan','parmigiano reggiano':'parmesan',
  'feta cheese':'feta','mozzarella cheese':'mozzarella','ricotta cheese':'ricotta','mascarpone cheese':'mascarpone','cheddar cheese':'cheddar','white cheddar cheese':'white cheddar','monterey jack cheese':'monterey jack','goat cheese crumble':'goat cheese','blue cheese crumble':'blue cheese','gruyere cheese':'gruyere','fontina cheese':'fontina','cheddar-jack blend':'cheddar-jack','cheddar jack blend':'cheddar-jack',
  'tamari soy sauce':'tamari','gluten-free soy sauce':'soy sauce','all-purpose flour':'flour','granulated sugar':'sugar','white sugar':'sugar','confectioners sugar':'powdered sugar','toasted sesame oil':'sesame oil','panko breadcrumb':'panko','panko breadcrumbs':'panko',
  'za atar spice mix':'za atar spice blend','za atar':'za atar spice blend','baharat spice mix':'baharat spice blend','baharat spice':'baharat spice blend','baharat':'baharat spice blend','italian dried herb mix':'italian seasoning','italian dried herb blend':'italian seasoning','italian herb blend':'italian seasoning','everything bagel spice mix':'everything bagel seasoning','mexican spice blend':'mexican spice mix','tex-mex spice mix':'tex-mex spice blend','harissa spice mix':'harissa spice blend','cajun spice blend':'cajun seasoning','fajita spice blend':'fajita spice mix','basque spice blend':'basque spice mix','mediterranean spice blend':'mediterranean spice mix','southwestern spice blend':'southwestern spice mix','warm spice mix':'warm spice blend','bbq spice mix':'bbq spice blend','pie spice mix':'pie spice blend','berbere spice mix':'berbere spice blend','berbere':'berbere spice blend','chorizo chili spice mix':'chorizo chili spice blend',
  'roasted peanut':'peanut','roasted almond':'almond','roasted cashew':'cashew','slivered almond':'almond','sliced almond':'almond','toasted sesame seed':'sesame seed','mixed sesame seed':'sesame seed','roasted sunflower seed':'sunflower seed',
  'chicken breast strip':'chicken breast','cubed chicken thigh':'chicken thigh','chicken thigh strip':'chicken thigh','ground beef pork veal':'ground meatloaf mix','jalape o chile':'jalapeno','jalape o':'jalapeno','jalapeno chile':'jalapeno','jalapeno pepper':'jalapeno','red radish':'radish','curly kale':'kale','tuscan kale':'kale','lacinato kale':'kale','romaine heart':'romaine','romaine lettuce':'romaine','yukon gold potato':'potato','russet potato':'potato','red-skinned potato':'potato','red potato':'potato','fingerling potato':'potato','plum tomato':'tomato','grape tomato':'cherry tomato','red bell pepper':'bell pepper','green bell pepper':'bell pepper','yellow bell pepper':'bell pepper','orange bell pepper':'bell pepper','green onion':'scallion','flat-leaf parsley':'parsley','italian parsley':'parsley','cilantro leaf':'cilantro','basil leaf':'basil','mint leaf':'mint','thai basil':'basil',
  'butter stick':'butter','salted butter':'butter','grape tomato':'cherry tomato','red-skinned potato':'potato','yukon gold potato':'potato','russet potato':'potato','fingerling potato':'potato','sweet potatoes':'sweet potato','haricots vert':'green bean','haricot vert':'green bean','english cucumber':'cucumber','persian cucumber':'cucumber','red radish':'radish','sweet pepper':'bell pepper','mini sweet pepper':'bell pepper','roasted red pepper':'roasted red peppers',
  'chicken broth concentrate':'chicken broth','chicken stock':'chicken broth','chicken bouillon cube':'chicken broth','chicken bouillon':'chicken broth','beef broth concentrate':'beef broth','beef stock':'beef broth','beef bouillon cube':'beef broth','turkey broth concentrate':'chicken broth','vegetable broth concentrate':'vegetable broth','vegetable stock':'vegetable broth','vegetable bouillon cube':'vegetable broth',
  'dark brown sugar':'brown sugar','light brown sugar':'brown sugar','whole-grain mustard':'grain mustard','grain mustard':'whole grain mustard','basil pesto':'pesto','gochugaru flake':'gochugaru','ground':'',
};
function canonIngredient(s) {
  let t = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/\([^)]*\)/g, ' ');
  t = t.replace(/\b\d+(\.\d+)?\s*(oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|ml|inch|in|ct|count)\b(\s*each)?/g, ' ');
  t = t.replace(/\b\d+([\/.]\d+)?\b/g, ' ');
  t = t.replace(/[^a-z\s-]/g, ' ');
  t = t.replace(STRIP_RE, ' ');
  t = t.replace(/(^|\s)-+|-+(\s|$)/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t && !KEEP_S.has(t)) {
    const last = t.split(' ').pop();
    if (!KEEP_S.has(last)) {
      t = t.replace(/(\w+?)ies$/, '$1y').replace(/(\w+?)(oes|ches|shes|sses|xes)$/, (m, a, b) => a + b.slice(0, -2)).replace(/(\w{3,}?)s$/, (m, a) => /(ss|us|is)$/.test(a + 's') ? a + 's' : a);
    }
  }
  if (t === 'ground') return '';
  return ALIASES[t] || t;
}
if (typeof module !== 'undefined') module.exports = { canonIngredient, ALIASES };
