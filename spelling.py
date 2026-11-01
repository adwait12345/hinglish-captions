"""Spelling fixes for captions: Hinglish texting-style spelling + your own words.

The transcription model writes Hindi in a formal transliteration ("tumhen",
"vah", "kuchh"), but people type Hinglish differently ("tumhe", "woh", "kuch").
Rules map one or more words to one or more words; word timings are kept, and
when the word count changes the original time span is shared out.
"""

import re

# Formal transliteration -> how Hinglish is usually typed. Only words that are
# unambiguous in Hinglish (no common English word clashes) belong here.
TEXTING = """
tumhen=tumhe unhen=unhe inhen=inhe jinhen=jinhe hamen=humein mainne=maine hamne=humne ham=hum
hamaara=humara hamaare=humare hamaari=humari tumhaara=tumhara tumhaare=tumhare tumhaari=tumhari
usmen=usme inmen=inme unmen=unme jismen=jisme kismen=kisme
vah=woh vo=woh yah=yeh vahan=wahan vahaan=wahan yahaan=yahan kahaan=kahan jahaan=jahan
vaala=wala vaale=wale vaali=wali vaalon=walon nahin=nahi kyon=kyun kyonki=kyunki kah=keh kahaa=kaha
kuchh=kuch achchha=accha achchhe=acche achchhi=acchi bachcha=baccha bachche=bacche sachchi=sacchi
chiz=cheez chizen=cheezein chizon=cheezon shaayad=shayad baaki=baki dekhana=dekhna bhoolna=bhulna
isake=iske usake=uske unake=unke inake=inke isaka=iska usaka=uska isaki=iski usaki=uski
karata=karta karate=karte karati=karti rahata=rehta rahate=rehte rahati=rehti padata=padta
lagata=lagta lagate=lagte lagati=lagti dekhata=dekhta chaahie=chahiye chaahiye=chahiye
kie=kiye gae=gaye gai=gayi aaega=aayega jaega=jayega thik=theek bhee=bhi vagairah=vagera alaava=alawa
ke_lie=ke_liye ki_lie=ki_liye uske_lie=uske_liye iske_lie=iske_liye unke_lie=unke_liye
inke_lie=inke_liye kis_lie=kis_liye isilie=isiliye isalie=isliye
"""


# Word endings typed differently in Hinglish (future tense: karoonga -> karunga).
TEXTING_SUFFIXES = [("oongaa", "unga"), ("oonga", "unga"), ("oongee", "ungi"), ("oongi", "ungi")]


def _suffix_fix(text):
    lead, core, trail = _split(text)
    low = core.lower()
    for old, new in TEXTING_SUFFIXES:
        if low.endswith(old) and len(low) > len(old) + 1:
            fixed = core[: len(core) - len(old)] + new
            return lead + fixed + trail
    return text


def texting_rules():
    rules = []
    for pair in TEXTING.split():
        a, b = pair.split("=")
        rules.append({"from": a.replace("_", " "), "to": b.replace("_", " ")})
    return rules


_EDGE = re.compile(r"^([^\w']*)(.*?)([^\w']*)$", re.UNICODE)


def _split(text):
    """'"Vah.' -> ('"', 'Vah', '.')"""
    return _EDGE.match(text).groups()


def _norm(text):
    return _split(text)[1].lower()


def build_table(texting=True, user_rules=()):
    """first word -> [(from words, to text)], longest phrases first.
    Your own rules win over the built-in texting ones."""
    rules = {}
    for r in (texting_rules() if texting else []) + list(user_rules):
        frm = tuple(_norm(w) for w in r["from"].split() if _norm(w))
        if frm and r.get("to", "").strip():
            rules[frm] = r["to"].strip()
    table = {}
    for frm, to in rules.items():
        table.setdefault(frm[0], []).append((frm, to))
    for v in table.values():
        v.sort(key=lambda x: -len(x[0]))
    table[None] = texting  # whether to also apply TEXTING_SUFFIXES
    return table


def fix_words(words, table):
    """words: [{"text", "start", "end", "em"?}] -> corrected list (new dicts)."""
    out, i = [], 0
    while i < len(words):
        for frm, to in table.get(_norm(words[i]["text"]), []):
            n = len(frm)
            span = words[i:i + n]
            if len(span) == n and tuple(_norm(w["text"]) for w in span) == frm:
                lead = _split(span[0]["text"])[0]
                trail = _split(span[-1]["text"])[2]
                tokens = to.split()
                core = _split(span[0]["text"])[1]
                # Keep a capital at the start of a sentence, unless the rule
                # spells its own capitals (brand names like "MacBook").
                if core[:1].isupper() and to == to.lower():
                    tokens[0] = tokens[0][:1].upper() + tokens[0][1:]
                tokens[0] = lead + tokens[0]
                tokens[-1] = tokens[-1] + trail
                em = any(w.get("em") for w in span)
                if len(tokens) == n:
                    new = [{**w, "text": t} for w, t in zip(span, tokens)]
                else:  # word count changed: share out the original time span
                    s, e = span[0]["start"], span[-1]["end"]
                    weights = [len(t) + 1 for t in tokens]
                    total, t0, new = sum(weights), s, []
                    for t, wgt in zip(tokens, weights):
                        d = (e - s) * wgt / total
                        new.append({"text": t, "start": round(t0, 3), "end": round(t0 + d, 3)})
                        t0 += d
                if em:
                    for w in new:
                        w["em"] = True
                out += new
                i += n
                break
        else:
            w = dict(words[i])
            if table.get(None):
                w["text"] = _suffix_fix(w["text"])
            out.append(w)
            i += 1
    return out


def fix_captions(captions, table):
    return [{**c, "words": fix_words(c["words"], table)} for c in captions]


def fix_word_tuples(words, table):
    """For the server's raw [(start, end, text)] word list."""
    fixed = fix_words([{"start": s, "end": e, "text": t} for s, e, t in words], table)
    return [(w["start"], w["end"], w["text"]) for w in fixed]
